process.env.TZ = "Asia/Karachi";
require('dotenv').config();

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const cron = require('node-cron');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const axios = require('axios');

// --- CONFIGURATION ---
const SOLIS_KEY_ID = process.env.SOLIS_KEY_ID;
const SOLIS_KEY_SECRET = process.env.SOLIS_KEY_SECRET;;
const SOLIS_API_URL = process.env.SOLIS_BASE_URL;
const BUFFER_LOAD = 0.20;
let lastAlertTime = 0;
let silencedUntil = 0;
const ALERT_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes in milliseconds


// Add numbers with country code and @c.us suffix
const authorizedNumbers = process.env.AUTHORIZED_NUMBERS ? process.env.AUTHORIZED_NUMBERS.split(',') : [];
const processedMessages = new Set();
const BILLING_START_DATE = 8; // The 10th of the month
// --- DATABASE SETUP ---
const db = new sqlite3.Database('./solar_data.db');
db.run(`CREATE TABLE IF NOT EXISTS daily_grid (date TEXT PRIMARY KEY, grid_usage REAL)`);

// --- WHATSAPP CLIENT SETUP ---
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        executablePath: '/usr/bin/chromium-browser', // Required for Oracle ARM
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

client.on('qr', (qr) => {
    // Generates the QR code in your SSH terminal
    qrcode.generate(qr, { small: true });
    console.log('Scan the QR code above with your WhatsApp app.');
});

client.on('ready', () => {
    console.log('WhatsApp Bot is ready and connected!');
});

// --- SOLIS API HELPERS

// --- HEADER GENERATOR
function generateSolisHeaders(endpoint, requestBody) {
    // 1. Create a Base64 encoded MD5 hash of the request body
    const contentMd5 = crypto.createHash('md5').update(requestBody).digest('base64');
    
    // 2. Generate the required GMT timestamp format
    const dateGmt = new Date().toUTCString();
    
    // 3. Assemble the strict multiline payload required for signing
    const paramString = `POST\n${contentMd5}\napplication/json\n${dateGmt}\n${endpoint}`;
    
    // 4. Encrypt the string using HMAC-SHA1 and your Solis API secret
    const signature = crypto.createHmac('sha1', SOLIS_KEY_SECRET)
                            .update(paramString)
                            .digest('base64');

    // 5. Return the finalized headers to the axios request
    return {
        'Content-MD5': contentMd5,
        'Date': dateGmt,
        'Content-Type': 'application/json',
        'Authorization': `API ${SOLIS_KEY_ID}:${signature}`
    };
}

// --- DYNAMIC INVERTER ID FETCHER ---
async function getInverterId() {
    try {
        // Step 1: Get the Station (Plant) ID first
        let endpoint = "/v1/api/userStationList";
        let requestBody = JSON.stringify({ pageNo: 1, pageSize: 10 });
        let headers = generateSolisHeaders(endpoint, requestBody);
        
        let response = await axios.post(`${SOLIS_API_URL}${endpoint}`, requestBody, { headers });
        let stations = response.data?.data?.page?.records;
        
        if (!stations || stations.length === 0) {
            console.error("No plants/stations found on this Solis account.");
            return null;
        }
        
        const stationId = stations[0].id; // Extract your Plant ID

        // Step 2: Use the Station ID to get the Inverter ID
        endpoint = "/v1/api/inverterList";
        requestBody = JSON.stringify({ stationId: stationId, pageNo: 1, pageSize: 10 });
        headers = generateSolisHeaders(endpoint, requestBody);
        
        response = await axios.post(`${SOLIS_API_URL}${endpoint}`, requestBody, { headers });
        let inverters = response.data?.data?.page?.records;
        
        if (inverters && inverters.length > 0) {
            return inverters[0].id; // Return the exact Inverter ID
        }
    } catch (error) {
        console.error("Error fetching data:", error.response ? error.response.data : error.message);
    }
    return null;
}

// --- MONTHLY DATA FETCHER ---

async function getMonthlyData(inverterId, yearMonthStr) {
    const endpoint = "/v1/api/inverterMonth";
    
    // Updated key from 'time' to 'month' as per V1.0 docs
    const requestBody = JSON.stringify({ id: inverterId, month: yearMonthStr });
    const headers = generateSolisHeaders(endpoint, requestBody);
    
    try {
        const response = await axios.post(`${SOLIS_API_URL}${endpoint}`, requestBody, { headers });
        return response.data?.data || [];
    } catch (error) {
        return [];
    }
}
// --- Get Full Data for today (HMAC-SHA1 Auth) ---
async function getInverterData() {
    const path = "/v1/api/inverterList";
    const body = '{"pageNo":1,"pageSize":10}';
    const contentMd5 = crypto.createHash('md5').update(body).digest('base64');
    const date = new Date().toUTCString();
    
    const stringToSign = `POST\n${contentMd5}\napplication/json\n${date}\n${path}`;
    const signature = crypto.createHmac('sha1', SOLIS_KEY_SECRET).update(stringToSign).digest('base64');
    const authHeader = `API ${SOLIS_KEY_ID}:${signature}`;

    try {
        const response = await axios.post(SOLIS_API_URL + path, body, {
            headers: {
                'Content-MD5': contentMd5,
                'Date': date,
                'Authorization': authHeader,
                'Content-Type': 'application/json'
            }
        });
        
        const inverter = response.data.data.page.records[0];
	return {
            load: inverter.totalLoadPower || 0, // kW
            production: inverter.pac || 0, // kW
            battery: inverter.batteryCapacitySoc || 0, // %
            battery_power: inverter.batteryPower || 0, // kW
            grid_power: inverter.psum || 0, // kW
            daily_grid: inverter.gridPurchasedEnergyDay || 0 // kWh
        };
    } catch (error){
	if (error.response) {
		console.error("Solis API Error Data:", error.response.data);
	} else {
		console.error("Error Message:", error.message);
	}
	return null;
    }
}

// --- SOLAR ALERT LOGIC ---
async function checkThresholds() {
    const hour = new Date().getHours();
    if (hour < 7 || hour > 17) return; 
    
    // return if the user has silenced alerts for now
    if (Date.now() < silencedUntil) {
        return;
    }

    const now = Date.now();
    // If 15 minutes have not passed since the last alert, stay silent
    if (now - lastAlertTime < ALERT_COOLDOWN_MS) {
        return; 
    }

    const data = await getInverterData();
    let nonSolarConsupmtion=0.0;
    if (!data){return};
    if (data.battery_power<0){
        nonSolarConsupmtion += Math.abs(data.battery_power)
    }
    if (data.grid_power<0){
        nonSolarConsupmtion += Math.abs(data.grid_power)
    }
    if (nonSolarConsupmtion >= BUFFER_LOAD) {
    
        const msg = `⚠️ *Solar Alert*\nHouse usage (${data.load} kW) is exceeding production (${data.production} kW) by ${nonSolarConsupmtion} kW, with` 
                        + `${-1*data.battery_power} from Battery and ${-1*data.grid_power}`;
        authorizedNumbers.forEach(num => client.sendMessage(num, msg));
        
        // Reset the timer after successfully sending the alert
        lastAlertTime = now;
    }
}

// --- DATABASE QUERIES ---
function getCycleGridUsage() {
    return new Promise((resolve, reject) => {
        const now = new Date();
        let billingYear = now.getFullYear();
        let billingMonth = now.getMonth(); // 0-indexed (Jan = 0)
        
        // If today is before the 10th, the billing cycle started last month
        if (now.getDate() < BILLING_START_DATE) {
            billingMonth -= 1;
            if (billingMonth < 0) {
                billingMonth = 11;
                billingYear -= 1;
            }
        }
        
        // Format the start date as YYYY-MM-DD
        // Note: Months are 0-indexed in JS Dates, but 1-indexed in ISO strings. 
        // We pad with 0s to match the SQLite database format.
        const startDate = `${billingYear}-${String(billingMonth + 1).padStart(2, '0')}-${String(BILLING_START_DATE).padStart(2, '0')}`;
        
        db.get(`SELECT SUM(grid_usage) as total FROM daily_grid WHERE date >= ?`, [startDate], (err, row) => {
            if (err || !row) {
                resolve(0);
            } else {
                resolve(row.total || 0);
            }
        });
    });
}

// --- INCOMING MESSAGE HANDLER ---
client.on('message', async msg => {
    // 1. De-duplication filter
    const messageId = msg.id.id;
    if (processedMessages.has(messageId)) return;
    processedMessages.add(messageId);

    if (processedMessages.size > 100) {
        const firstItem = processedMessages.values().next().value;
        processedMessages.delete(firstItem);
    }

    const chatId = msg.fromMe ? msg.to : msg.from;
    

    let text = msg.body || '';
    text = text.toLowerCase().trim();
    
    // 3. Only run the API and log if it is exactly the status command
    if (text === 'status' || text === 'stats') {
        console.log(`[${new Date().toLocaleTimeString()}] Status request received from ${chatId}`);
        const data = await getInverterData();
        
        if (data) {
            // Fetch past days from DB
            const savedCycleGrid = await getCycleGridUsage();
            const totalMonthlyGrid = (savedCycleGrid + data.daily_grid).toFixed(2); 

            const reply = `🔋 *Current Status*\n` +
                          `Battery SOC: ${data.battery}%\n` +
                          `Battery Power: ${data.battery_power} kW\n` +
                          `Solar Production: ${data.production} kW\n` +
                          `House Usage: ${data.load} kW\n` +
                          `Grid Power: ${data.grid_power} kW\n` +
                          `Grid Used Today: ${data.daily_grid} kWh\n` +
                          `📊 *Cycle Grid Used (Since ${BILLING_START_DATE}th): ${totalMonthlyGrid} kWh*`;
            
            // FIX 3: Use msg.reply() to safely route back to the correct device/chat
            msg.reply(reply);
        } else {
            msg.reply("❌ Could not reach Solis API.");
        }
    }
    
    // Check if the user wants to silence alerts
    if (text.startsWith('silent')) {
        const parts = text.split(' ');
        
        if (parts.length > 1) {
            // Convert their string into a decimal float (e.g., 2.33333)
            const hoursToSilent = parseFloat(parts[1]);
            // Validation check
            if (isNaN(hoursToSilent) || hoursToSilent < 0) {
                msg.reply("❌ Invalid format. Please use a positive number (e.g., 'silent 1.5' or 'silent 2').");
                return;
            }

            // ensure that the alert is not silenced by the last alert time after being overridden by the silent message
            lastAlertTime = 0;
            // Un-mute shortcut
            if (hoursToSilent === 0) {
                 silencedUntil = 0;
                 msg.reply("🔊 Alerts are now UN-silenced and active.");
                 return;
            }
            
            // Calculate milliseconds for the system
            const silentMs = hoursToSilent * 60 * 60 * 1000;
            silencedUntil = Date.now() + silentMs;
            
            // Calculate human-readable hours and minutes for the confirmation message
            const totalMinutes = Math.round(hoursToSilent * 60);
            const formatHours = Math.floor(totalMinutes / 60);
            const formatMinutes = totalMinutes % 60;
            
            let timeStr = "";
            if (formatHours > 0) timeStr += `${formatHours} hour${formatHours > 1 ? 's' : ''} `;
            if (formatMinutes > 0) timeStr += `${formatMinutes} minute${formatMinutes > 1 ? 's' : ''}`;
            
            // Calculate exactly what time it will expire in Karachi
            const untilDate = new Date(silencedUntil);
            const timeString = untilDate.toLocaleTimeString('en-US', { 
                hour: 'numeric', 
                minute: '2-digit', 
                hour12: true, 
                timeZone: 'Asia/Karachi' 
            });

            msg.reply(`🔕 Alerts silenced for ${timeStr.trim()} (until ${timeString}).`);
        } else {
             msg.reply("❌ Please specify the hours (e.g., 'silent 1' or 'silent 0.5'). To turn off, use 'silent 0'.");
        }
    }

    // --- UNITS BILLING CYCLE COMMAND ---
    if (text.toLowerCase().startsWith('units')) {
        const parts = text.trim().split(/\s+/);
        
        if (parts.length < 2) {
            msg.reply("❌ Please provide a month. E.g., 'units august' or 'units sept 26'.");
            return;
        }

        const monthInput = parts[1].toLowerCase();
        
        // Map to handle both full names and universal short forms
        const monthsMap = {
            jan: 1, january: 1,
            feb: 2, february: 2,
            mar: 3, march: 3,
            apr: 4, april: 4,
            may: 5,
            jun: 6, june: 6,
            jul: 7, july: 7,
            aug: 8, august: 8,
            sep: 9, sept: 9, september: 9,
            oct: 10, october: 10,
            nov: 11, november: 11,
            dec: 12, december: 12
        };

        const startMonth = monthsMap[monthInput];
        if (!startMonth) {
            msg.reply("❌ Invalid month. Please use a valid name (e.g., 'August' or 'Sept').");
            return;
        }

        // Default to the current year if not provided
        let startYear = new Date().getFullYear();
        if (parts.length > 2) {
            const parsedYear = parseInt(parts[2], 10);
            if (!isNaN(parsedYear)) {
                // Instantly converts a 2-digit year like '26' to '2026'
                startYear = parsedYear < 100 ? 2000 + parsedYear : parsedYear;
            }
        }

        msg.reply("⏳ Fetching your billing data from Solis Cloud. Please wait...");

        // 1. Get the dynamic Inverter ID
        const inverterId = await getInverterId();
        if (!inverterId) {
            msg.reply("❌ Could not retrieve your Inverter ID from Solis Cloud.");
            return;
        }

        // 2. Calculate the target months and the end date
        let endMonth = startMonth + 1;
        let endYear = startYear;
        
        if (endMonth > 12) {
            endMonth = 1;
            endYear += 1;
        }

        const startStr = `${startYear}-${String(startMonth).padStart(2, '0')}`;
        const endStr = `${endYear}-${String(endMonth).padStart(2, '0')}`;
        
        // Dynamically calculate the end day (e.g., if start is 10, end is 9)
        const billingEndDay = BILLING_START_DATE - 1;

        const [startMonthData, endMonthData] = await Promise.all([
            getMonthlyData(inverterId, startStr),
            getMonthlyData(inverterId, endStr)
        ]);

        let totalGenerated = 0;
        let totalImported = 0;
        let daysLogged = 0;

        // 4. Process Start Month (Count days from BILLING_START_DATE onward)
        startMonthData.forEach(day => {
            // Convert the Long timestamp (e.g., 1564088700000) to a Date object
            const dateObj = new Date(day.date);
            const dayNum = dateObj.getDate(); 

            if (dayNum >= BILLING_START_DATE) {
                totalGenerated += (day.energy || 0); 
                totalImported += (day.gridPurchasedEnergy || 0); 
                daysLogged++;
            }
        });

        // 5. Process End Month (Count days up to billingEndDay)
        endMonthData.forEach(day => {
            const dateObj = new Date(day.date);
            const dayNum = dateObj.getDate();

            if (dayNum <= billingEndDay) {
                totalGenerated += (day.energy || 0);
                totalImported += (day.gridPurchasedEnergy || 0);
                daysLogged++;
            }
        });

        // 6. Reply to user with dynamic dates
        const displayMonths = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        const titleStart = `${displayMonths[startMonth - 1]} ${String(BILLING_START_DATE).padStart(2, '0')}, ${startYear}`;
        const titleEnd = `${displayMonths[endMonth - 1]} ${String(billingEndDay).padStart(2, '0')}, ${endYear}`;

        msg.reply(`📊 *Billing Cycle: ${titleStart} to ${titleEnd}*\n\n☀️ Solar Generation: ${totalGenerated.toFixed(2)} kWh\n🔌 KE Imported: ${totalImported.toFixed(2)} kWh\n📅 Days Logged: ${daysLogged}`);
    }

    // --- HELP COMMAND ---
    if (text.toLowerCase() === 'help') {
        const helpMessage = `🤖 *Solis Bot Commands* 🤖\n\n` +
            `Here is what I can do for you:\n\n` +
            `*1. Check Live Status*\n` +
            `Type: \`status\`\n` +
            `_Fetches real-time solar generation, KE grid metrics, and inverter status._\n\n` +
            `*2. Silence Alerts*\n` +
            `Type: \`silent [hours]\`\n` +
            `_Mutes automated threshold alerts for the specified time._\n` +
            `• *Example:* \`silent 1\` (Mutes for 1 hour)\n` +
            `• *Example:* \`silent 1.5\` (Mutes for 1 hour 30 mins)\n` +
            `• *Example:* \`silent 0\` (Un-mutes alerts immediately)\n\n` +
            `*3. Billing Cycle Units*\n` +
            `Type: \`units [month] [year]\`\n` +
            `_Calculates total solar generation and grid import for your custom billing cycle._\n` +
            `• *Example:* \`units august\` (Calculates Aug 10 - Sep 09 of the current year)\n` +
            `• *Example:* \`units sept 26\` (Calculates Sep 10 - Oct 09 of 2026)`;
            
        msg.reply(helpMessage);
    }
});

// --- SCHEDULE JOBS ---
cron.schedule('*/5 7-17 * * *', () => {
    checkThresholds(); 
}, {
    timezone: "Asia/Karachi"
});

cron.schedule('55 23 * * *', async () => {
    // Save daily grid usage at 11:55 PM
    const data = await getInverterData();
    if (data) {
        const today = new Date().toISOString().split('T')[0];
        db.run(`REPLACE INTO daily_grid (date, grid_usage) VALUES (?, ?)`, [today, data.daily_grid]);
    }
}, {
    timezone: "Asia/Karachi"
});

client.initialize();