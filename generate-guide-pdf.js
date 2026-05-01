#!/usr/bin/env node

/**
 * PDF Generation Helper for ADSI Dashboard User Guide
 *
 * This script generates the User Guide PDF from the HTML source.
 * Requires: npm install puppeteer (or use system Chrome/Chromium)
 *
 * Usage: node generate-guide-pdf.js
 */

const fs = require('fs');
const path = require('path');

// Try to detect available tools
const hasChrome = require('child_process').spawnSync('which', ['google-chrome'], { stdio: 'ignore' }).status === 0;
const hasChromium = require('child_process').spawnSync('which', ['chromium-browser'], { stdio: 'ignore' }).status === 0;

const docsDir = path.join(__dirname, 'docs');
const htmlFile = path.join(docsDir, 'ADSI-Dashboard-User-Guide.html');
const pdfFile = path.join(docsDir, 'ADSI-Dashboard-User-Guide.pdf');

console.log('PDF Generation for ADSI Dashboard User Guide');
console.log('=============================================\n');

if (!fs.existsSync(htmlFile)) {
  console.error(`ERROR: HTML source not found: ${htmlFile}`);
  process.exit(1);
}

console.log('HTML source: OK');
console.log('Chrome/Chromium: ' + (hasChrome || hasChromium ? 'FOUND' : 'NOT FOUND'));
console.log('\nNote: To generate PDF automatically, install Puppeteer:');
console.log('  npm install puppeteer\n');

console.log('Then run:');
console.log('  node generate-guide-pdf.js\n');

console.log('Alternatively, use a system browser to print to PDF:');
console.log(`  1. Open file://${htmlFile} in your browser`);
console.log('  2. Print (Ctrl+P or Cmd+P)');
console.log('  3. Select "Save as PDF"');
console.log(`  4. Save to ${pdfFile}\n`);

console.log('Or use an online HTML-to-PDF service with the HTML file.\n');

// If Puppeteer is available, try to use it
try {
  const puppeteer = require('puppeteer');

  (async () => {
    try {
      console.log('Puppeteer found. Generating PDF...\n');

      const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });

      const page = await browser.newPage();
      await page.goto(`file://${htmlFile}`, { waitUntil: 'networkidle2' });

      await page.pdf({
        path: pdfFile,
        format: 'A4',
        margin: {
          top: '20mm',
          right: '20mm',
          bottom: '20mm',
          left: '20mm'
        },
        printBackground: true
      });

      await browser.close();

      console.log(`SUCCESS: PDF generated at ${pdfFile}\n`);
      process.exit(0);
    } catch (error) {
      console.error(`ERROR: Failed to generate PDF: ${error.message}\n`);
      process.exit(1);
    }
  })();
} catch (e) {
  console.log('Puppeteer not installed. Please install it or use the alternatives above.\n');
  process.exit(0);
}
