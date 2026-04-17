import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import axios from "axios";
import cors from "cors";

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());
  app.use(cors());

  // Simple JSON-based persistence to mimic "dashboard.db" but in a Node environment
  // This satisfies the user's request for "server state" while we have Firebase for future growth
  const STATE_FILE = path.join(process.cwd(), "dashboard_state.json");

  // Initial state if file doesn't exist
  if (!fs.existsSync(STATE_FILE)) {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      projects: [],
      lastUpdated: new Date().toISOString()
    }, null, 2));
  }

  // API Routes
  app.get("/api/state", (req, res) => {
    try {
      const data = fs.readFileSync(STATE_FILE, "utf-8");
      res.json(JSON.parse(data));
    } catch (error) {
      res.status(500).json({ error: "Failed to read state" });
    }
  });

  app.post("/api/state", (req, res) => {
    try {
      const newState = req.body;
      fs.writeFileSync(STATE_FILE, JSON.stringify(newState, null, 2));
      res.json({ status: "ok", message: "State updated" });
    } catch (error) {
      res.status(500).json({ error: "Failed to save state" });
    }
  });

  // Google Sheets Proxy
  app.get("/api/fetch-sheet", async (req, res) => {
    let sheetUrl = req.query.url as string;
    if (!sheetUrl) {
      return res.status(400).json({ error: "URL is required" });
    }

    // Auto-convert standard sheet URL to CSV export URL if it's a known Google Sheet pattern
    if (sheetUrl.includes("docs.google.com/spreadsheets/d/")) {
      const match = sheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
      if (match) {
        const spreadsheetId = match[1];
        // Handle both ?gid= and #gid=
        const gidMatch = sheetUrl.match(/[#?&]gid=(\d+)/);
        sheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv`;
        if (gidMatch) sheetUrl += `&gid=${gidMatch[1]}`;
      }
    }

    try {
      const response = await axios.get(sheetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        },
        timeout: 30000
      });

      // Simple heuristic to detect if Google returned an HTML login page instead of CSV
      const contentType = response.headers['content-type'] || '';
      if (contentType.includes('text/html') && typeof response.data === 'string' && response.data.includes('google-signin')) {
        return res.status(403).json({ 
          error: "Permission Denied", 
          details: "This sheet appears to be private. Please set your Google Sheet sharing to 'Anyone with the link can view' or 'Publish to the web' as CSV."
        });
      }

      res.send(typeof response.data === 'object' ? JSON.stringify(response.data) : response.data);
    } catch (error: any) {
      console.error("Error fetching sheet:", error.message);
      const status = error.response?.status || 500;
      const message = error.response?.data || error.message;
      res.status(status).json({ 
        error: "Failed to fetch sheet data", 
        details: message,
        status: status 
      });
    }
  });

  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
