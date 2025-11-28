// server.js
// Tiny LightX proxy for Bubble (Railway, Render, etc.)
//
// Single endpoint:
//   POST /lightx/run-tool
//
// Bubble sends:
// {
//   "imageUrl": "https://bubble-file-url",   // NOT needed for text2image
//   "tool": "remove-background",             // cartoon, portrait, image2image, caricature, etc.
//   "params": { ... }                        // tool-specific options (mostly prompts/options)
// }

const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: "10mb" }));

const LIGHTX_API_KEY = process.env.LIGHTX_API_KEY;
const LIGHTX_BASE = "https://api.lightxeditor.com/external/api/v2";

// Small helper: sleep
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Helper: POST JSON to LightX with API key
async function lightxPost(path, body) {
  const res = await axios.post(`${LIGHTX_BASE}${path}`, body, {
    headers: {
      "Content-Type": "application/json",
      "x-api-key": LIGHTX_API_KEY,
    },
    validateStatus: () => true, // we'll handle errors
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(
      `LightX ${path} failed: HTTP ${res.status} ${JSON.stringify(res.data)}`
    );
  }

  return res.data;
}

// Simple healthcheck
app.get("/", (req, res) => {
  res.send("LightX proxy is running");
});

// Main generic endpoint
app.post("/lightx/run-tool", async (req, res) => {
  try {
    const {
      imageUrl,   // Bubble file URL (not needed for text2image)
      tool,       // e.g. "cartoon", "remove-background", "portrait", "image2image", "caricature", "text2image"
      params = {} // tool-specific options/prompts
    } = req.body;

    if (!LIGHTX_API_KEY) {
      return res
        .status(500)
        .json({ success: false, error: "LIGHTX_API_KEY is not set" });
    }

    if (!tool) {
      return res
        .status(400)
        .json({ success: false, error: "tool is required" });
    }

    // Special case: text2image - no input image to upload
    if (tool === "text2image") {
      const toolResp = await lightxPost("/text2image", params);
      return res.json({ success: true, tool, raw: toolResp });
    }

    // All other tools need an image
    if (!imageUrl) {
      return res.status(400).json({
        success: false,
        error: "imageUrl is required for this tool",
      });
    }

    // 1) HEAD the Bubble image to get size + content type
    const headResp = await axios.head(imageUrl, { validateStatus: () => true });

    if (headResp.status < 200 || headResp.status >= 300) {
      throw new Error(
        `Could not read image headers: HTTP ${headResp.status}`
      );
    }

    const sizeHeader = headResp.headers["content-length"];
    const typeHeader = headResp.headers["content-type"];

    if (!sizeHeader) {
      throw new Error("Bubble image has no Content-Length header");
    }

    const size = parseInt(sizeHeader, 10);
    const contentType = typeHeader || "image/jpeg";

    // 2) Ask LightX for upload URL
    const uploadInit = await lightxPost("/uploadImageUrl", {
      uploadType: "imageUrl",
      size,
      contentType,
    });

    if (uploadInit.statusCode !== 2000) {
      throw new Error(
        `uploadImageUrl statusCode != 2000: ${JSON.stringify(uploadInit)}`
      );
    }

    const uploadUrl = uploadInit.body?.uploadImage;
    const finalImageUrl = uploadInit.body?.imageUrl;

    if (!uploadUrl || !finalImageUrl) {
      throw new Error(
        `Missing uploadImage or imageUrl: ${JSON.stringify(uploadInit)}`
      );
    }

    // 3) Download image from Bubble as binary
    const fileResp = await axios.get(imageUrl, {
      responseType: "arraybuffer",
      validateStatus: () => true,
    });

    if (fileResp.status < 200 || fileResp.status >= 300) {
      throw new Error(
        `Failed to GET Bubble image: HTTP ${fileResp.status}`
      );
    }

    const fileBuffer = Buffer.from(fileResp.data);

    // 4) PUT to LightX S3 upload URL
    const putResp = await axios.put(uploadUrl, fileBuffer, {
      headers: {
        "Content-Type": contentType,
        "Content-Length": fileBuffer.length,
      },
      validateStatus: () => true,
    });

    if (putResp.status < 200 || putResp.status >= 300) {
      throw new Error(
        `S3 upload failed: HTTP ${putResp.status} ${putResp.statusText}`
      );
    }

    // 5) Call the chosen LightX tool
    // e.g. tool = "cartoon" → POST /cartoon
    const toolPath = `/${tool}`;

    const toolResp = await lightxPost(toolPath, {
      imageUrl: finalImageUrl,
      ...params,
    });

    const orderId = toolResp.body?.orderId;
    const retries = toolResp.body?.maxRetriesAllowed ?? 5;

    // Some tools might be synchronous and not return orderId
    if (!orderId) {
      return res.json({
        success: true,
        tool,
        synchronous: true,
        raw: toolResp,
      });
    }

    // 6) Poll order-status until active/failed
    let statusResp;
    let status;

    for (let i = 0; i < retries; i++) {
      await sleep(3000);
      statusResp = await lightxPost("/order-status", { orderId });
      status = statusResp.body?.status;
      if (status === "active" || status === "failed") break;
    }

    if (status !== "active") {
      return res.json({
        success: false,
        tool,
        status,
        raw: statusResp,
      });
    }

    // Final success – output contains result URLs/data
    return res.json({
      success: true,
      tool,
      status,
      output: statusResp.body?.output,
    });
  } catch (err) {
    console.error("Error in /lightx/run-tool:", err.message);
    return res
      .status(500)
      .json({ success: false, error: err.message || "Unknown error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server listening on", PORT);
});
