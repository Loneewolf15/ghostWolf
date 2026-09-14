const { app, desktopCapturer, screen } = require('electron');
app.whenReady().then(async () => {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.size;
    console.log(`Display size: ${width}x${height}`);
    const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width, height }
    });
    if (sources.length > 0) {
        const bmp = sources[0].thumbnail.toBitmap();
        console.log(`Bitmap length: ${bmp.length}, Expected: ${width * height * 4}`);
    }
    app.quit();
});
