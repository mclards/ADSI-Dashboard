import sqlite3
import hmac
import hashlib
import time
import base64
import struct
import json
import requests

def get_totp_token(secret: str) -> str:
    # Decode base32 secret
    # Pad to multiple of 8
    padding = '=' * ((8 - len(secret) % 8) % 8)
    key = base64.b32decode(secret + padding, casefold=True)
    
    # 30 second window
    timestamp = int(time.time()) // 30
    msg = struct.pack(">Q", timestamp)
    
    # HMAC-SHA1
    h = hmac.new(key, msg, hashlib.sha1).digest()
    o = h[19] & 15
    token = (struct.unpack(">I", h[o:o+4])[0] & 0x7fffffff) % 1000000
    return f"{token:06d}"

def test_login():
    db_path = r"C:\ProgramData\InverterDashboard\db\adsi.db"
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    c = conn.cursor()
    c.execute("SELECT value FROM settings WHERE key='solcastToolkitPassword'")
    row = c.fetchone()
    if not row:
        print("Password not found")
        return
    password = row[0]
    
    email = "adsi.om@alterpowerdigos.com"
    secret = "KG327CRMRTJSQDLFYUTE4MVI4LQZUBCF"
    totp = get_totp_token(secret)
    print(f"Generated TOTP: {totp}")
    
    url = "https://api.solcast.com.au/auth/credentials"
    
    # Test JSON submission
    payload = {
        "userName": email,
        "password": password,
        "rememberMe": "true",
        "meta": { "TwoFactorCode": totp }
    }
    
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json"
    }
    
    print("Sending POST...")
    resp = requests.post(url, json=payload, headers=headers)
    print("Status:", resp.status_code)
    print("Response:", resp.text[:200])
    print("Cookies:", resp.cookies.get_dict())

if __name__ == "__main__":
    test_login()
