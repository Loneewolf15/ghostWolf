document.addEventListener('DOMContentLoaded', async () => {
  const hwidDisplay = document.getElementById('hwid-display');
  const copyBtn = document.getElementById('copy-hwid-btn');
  const licenseInput = document.getElementById('license-input');
  const activateBtn = document.getElementById('activate-btn');
  const errorMsg = document.getElementById('error-msg');
  const quitBtn = document.getElementById('quit-btn');

  // Fetch the hardware ID from the main process
  let hwid = '';
  try {
    hwid = await window.ghostwolf.getHardwareId();
    hwidDisplay.textContent = hwid;
  } catch (err) {
    hwidDisplay.textContent = 'Error fetching signature';
    console.error(err);
  }

  // Copy hardware ID to clipboard
  copyBtn.addEventListener('click', () => {
    if (hwid) {
      navigator.clipboard.writeText(hwid);
      const originalText = copyBtn.textContent;
      copyBtn.textContent = 'Copied!';
      setTimeout(() => { copyBtn.textContent = originalText; }, 2000);
    }
  });

  // Handle activation
  activateBtn.addEventListener('click', async () => {
    const key = licenseInput.value.trim();
    if (!key) return;

    activateBtn.disabled = true;
    errorMsg.style.display = 'none';
    activateBtn.textContent = 'Verifying...';

    const isValid = await window.ghostwolf.verifyAndSaveLicense(key);
    
    if (isValid) {
      activateBtn.textContent = 'Activated!';
      activateBtn.style.background = '#059669'; // darker green
      // The main process will handle closing this window and opening the main app
    } else {
      errorMsg.style.display = 'block';
      activateBtn.disabled = false;
      activateBtn.textContent = 'Activate';
    }
  });

  // Allow pressing Enter in the input field
  licenseInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') activateBtn.click();
  });

  // Quit app
  quitBtn.addEventListener('click', () => {
    window.ghostwolf.quit();
  });
});
