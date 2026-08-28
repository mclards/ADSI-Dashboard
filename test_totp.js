const crypto = require('crypto');

function generateTOTP(secret, window = 0) {
    const base32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';
    for (let i = 0; i < secret.length; i++) {
        const val = base32.indexOf(secret.charAt(i).toUpperCase());
        bits += val.toString(2).padStart(5, '0');
    }
    const key = Buffer.alloc(Math.floor(bits.length / 8));
    for (let i = 0; i < key.length; i++) {
        key[i] = parseInt(bits.substring(i * 8, i * 8 + 8), 2);
    }
    
    const epoch = Math.round(Date.now() / 1000.0);
    const time = Buffer.alloc(8);
    let counter = Math.floor(epoch / 30) + window;
    time.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
    time.writeUInt32BE(counter & 0xffffffff, 4);

    const hmac = crypto.createHmac('sha1', key);
    hmac.update(time);
    const digest = hmac.digest();
    
    const offset = digest[digest.length - 1] & 0xf;
    const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 1000000;
    return code.toString().padStart(6, '0');
}

const secret = "KG327CRMRTJSQDLFYUTE4MVI4LQZUBCF";
console.log("Current TOTP code:", generateTOTP(secret));

async function testSolcast() {
    const userName = "adsi.om@alterpowerdigos.com";
    const Database = require('better-sqlite3');
    const db = new Database("C:\\ProgramData\\InverterDashboard\\db\\adsi.db", { readonly: true });
    const row = db.prepare("SELECT value FROM settings WHERE key='solcastToolkitPassword'").get();
    const password = row.value;
    db.close();

    const authUrl = "https://api.solcast.com.au/auth/credentials";
    const totpCode = generateTOTP(secret);
    console.log("Submitting login with TOTP:", totpCode);
    
    const resp = await fetch(authUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Accept": "application/json"
        },
        body: JSON.stringify({
            userName,
            password,
            rememberMe: true,
            meta: { TwoFactorCode: totpCode }
        })
    });
    
    console.log("HTTP Status:", resp.status);
    console.log("Response Text:", await resp.text());
    console.log("Cookies:", resp.headers.get("set-cookie"));
}

testSolcast().catch(console.error);
