import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Body parser for handling large PDF payloads
  app.use(express.json({ limit: '60mb' }));
  app.use(express.urlencoded({ extended: true, limit: '60mb' }));

  // In-memory store for generated PDFs (expires after 15 mins)
  const pdfCache = new Map<string, { buffer: Buffer; filename: string; contentType: string; createdAt: number }>();

  // Periodically clean expired items
  setInterval(() => {
    const now = Date.now();
    for (const [id, item] of pdfCache.entries()) {
      if (now - item.createdAt > 15 * 60 * 1000) {
        pdfCache.delete(id);
      }
    }
  }, 60000);

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  // Serve pdf.js worker locally
  app.get('/pdf.worker.min.mjs', (req, res) => {
    res.setHeader('Content-Type', 'text/javascript');
    res.sendFile(path.join(process.cwd(), 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs'));
  });

  // Stage PDF for direct HTTP download with attachment headers & filename in URL
  app.post('/api/prepare-pdf', (req, res) => {
    try {
      const { base64Data, filename } = req.body;
      if (!base64Data) {
        return res.status(400).json({ error: 'Missing base64Data' });
      }

      const cleanFilename = (filename || 'Mock_World_Result.pdf')
        .replace(/[^\w\s.-]/gi, '_')
        .replace(/\s+/g, '_');

      // Robust extraction of base64 binary content regardless of prefix
      const commaIdx = base64Data.indexOf(',');
      const rawBase64 = commaIdx !== -1 ? base64Data.substring(commaIdx + 1) : base64Data;
      const binaryBuffer = Buffer.from(rawBase64, 'base64');

      const downloadId = 'pdf_' + Math.random().toString(36).substring(2, 10) + '_' + Date.now();

      pdfCache.set(downloadId, {
        buffer: binaryBuffer,
        filename: cleanFilename,
        contentType: 'application/pdf',
        createdAt: Date.now()
      });

      const downloadUrl = `/api/download-pdf/${downloadId}/${encodeURIComponent(cleanFilename)}`;
      const viewUrl = `/api/view-pdf/${downloadId}/${encodeURIComponent(cleanFilename)}`;
      res.json({
        success: true,
        downloadId,
        downloadUrl,
        viewUrl,
        filename: cleanFilename
      });
    } catch (err: any) {
      console.error('Error staging PDF for download:', err);
      res.status(500).json({ error: err?.message || 'Failed to prepare PDF' });
    }
  });

  // Serve the PDF with full HTTP Content-Disposition headers for Android WebView DownloadManager
  app.get('/api/download-pdf/:id/:filename?', (req, res) => {
    const { id } = req.params;
    const pdfItem = pdfCache.get(id);

    if (!pdfItem) {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html>
        <head><title>PDF Expired</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
        <body style="font-family:sans-serif;text-align:center;padding:40px;">
          <h2>PDF Download Link Expired</h2>
          <p>Please return to the Mock World app and click <b>Download Result PDF</b> again.</p>
        </body>
        </html>
      `);
    }

    const safeFilename = pdfItem.filename.replace(/["\r\n]/g, '');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodeURIComponent(safeFilename)}`
    );
    res.setHeader('Content-Length', pdfItem.buffer.length);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Accept-Ranges', 'bytes');

    res.end(pdfItem.buffer);
  });

  // Inline view endpoint for mobile browsers / preview
  app.get('/api/view-pdf/:id/:filename?', (req, res) => {
    const { id } = req.params;
    const pdfItem = pdfCache.get(id);

    if (!pdfItem) {
      return res.status(404).send('PDF not found or expired.');
    }

    const safeFilename = pdfItem.filename.replace(/["\r\n]/g, '');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${safeFilename}"`);
    res.setHeader('Content-Length', pdfItem.buffer.length);

    res.end(pdfItem.buffer);
  });

  // Server build timestamp for clients to check for newly published updates
  const SERVER_BUILD_TIME = Date.now().toString();
  app.get('/api/version', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.json({
      version: '2.9.0',
      buildTime: SERVER_BUILD_TIME,
      timestamp: Date.now()
    });
  });

  // Vite middleware setup
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    // Serve hashed assets with long cache, but prevent caching HTML so new deployments apply immediately
    app.use(express.static(distPath, {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html') || filePath.endsWith('.htm')) {
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
          res.setHeader('Pragma', 'no-cache');
          res.setHeader('Expires', '0');
        } else if (filePath.includes('/assets/') || filePath.match(/\.[a-f0-9]{8,}\.(js|css)$/)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          res.setHeader('Cache-Control', 'no-cache, must-revalidate');
        }
      }
    }));
    app.get('*', (req, res) => {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Mock World server running on http://localhost:${PORT}`);
  });
}

startServer();
