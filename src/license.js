const crypto = require('crypto');
const os = require('os');
const { execSync } = require('child_process');
const store = require('./store'); // to get/set licenseKey

// This is the public key used to verify the license signature.
// The private key must be kept secret on the server/storefront.
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAlrQi5nIjHmoRrXpL7fEs
HMDdMmYVz+RLD23Bi4TSHCbLo/uGyhI/rOy/Yw+Y0NY8fhO0uWdpYJDYNSwRekMR
CKvLZTgb3h7AtT0u8UL1Kib4GVfx7t/YDiD42Tb7EO8gnt1e/V61ppt0B9JYEOhJ
NoSz4QtDernHVjc1xw03YU9QYmCpuHJkVuHiSHd612afHDTnA/mGtjLQCS9ZQdsy
2IkgREC0PFPXFEKk4u3T2nrEls/UCEtwlwftSBnRrSgRLPzjPVbuZI9ixi/TV472
zrV4zFPZfxr6kiCI6Q4avAwcrw8Ix3jmGdMmnumQdeGoF5Pi+4twCeHZ+7okq4P/
twIDAQAB
-----END PUBLIC KEY-----`;

/**
 * Gets the unique hardware ID for this device without external dependencies.
 */
function getHardwareId() {
  try {
    let hwid = '';
    switch (process.platform) {
      case 'win32':
        hwid = execSync('wmic csproduct get uuid', { encoding: 'utf8' }).replace('UUID', '').trim();
        break;
      case 'darwin':
        const ioreg = execSync('ioreg -rd1 -c IOPlatformExpertDevice', { encoding: 'utf8' });
        const match = ioreg.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
        if (match) hwid = match[1];
        break;
      case 'linux':
        hwid = execSync('cat /etc/machine-id 2>/dev/null || cat /var/lib/dbus/machine-id', { encoding: 'utf8' }).trim();
        break;
    }
    if (hwid) return hwid;
  } catch (err) {
    console.error('Failed to get machine ID via OS:', err);
  }
  
  // Fallback to mac address + hostname + cpu info hash if all else fails
  const hash = crypto.createHash('sha256');
  hash.update(os.hostname());
  hash.update(os.arch());
  hash.update(os.platform());
  const cpus = os.cpus();
  if (cpus && cpus.length > 0) hash.update(cpus[0].model);
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (!net.internal && net.mac !== '00:00:00:00:00:00') {
        hash.update(net.mac);
        break;
      }
    }
  }
  return hash.digest('hex').substring(0, 32);
}

/**
 * Verifies if the provided license key is a valid signature for this device's hardware ID.
 */
function verifyLicense(licenseKey) {
  if (!licenseKey) return false;
  try {
    const hwid = getHardwareId();
    const verifier = crypto.createVerify('SHA256');
    verifier.update(hwid);
    verifier.end();

    const signatureBuf = Buffer.from(licenseKey, 'base64');
    return verifier.verify(PUBLIC_KEY, signatureBuf);
  } catch (err) {
    console.error('License verification error:', err);
    return false;
  }
}

/**
 * Loads the saved license key and verifies it.
 */
function loadAndVerifyLicense() {
  const settings = store.getSettings();
  const key = settings.licenseKey || '';
  return verifyLicense(key);
}

/**
 * Saves a license key to the store.
 */
function saveLicense(licenseKey) {
  store.setSettings({ licenseKey });
}

module.exports = {
  getHardwareId,
  verifyLicense,
  loadAndVerifyLicense,
  saveLicense
};
