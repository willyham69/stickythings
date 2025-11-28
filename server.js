const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: "10mb" }));

const LIGHTX_API_KEY = process.env.LIGHTX_API_KEY;
const LIGHTX_BASE = "https://api.lightxeditor.com/external/api/v2";

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function lightxPost(path, body) {
  const res = await axios.post(`${LIGHTX_BASE}${path}`, body, {
    headers: {
      "Content-Type": "application/json",
      "x-api-key": LIGHTX_API_KEY
    },
    validateStatus: () => true
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(
      `LightX ${path} failed: ${res.status} ${JSON.stringify(res.data)}`
    );
  }

  return res.data;
}

// Simple health-check so we know the app is alive
app.get("/", (req, res) => {
  res.send("LightX proxy is running");
});

app.post("/lightx/remove-bg", async (req, res) => {
  try {
    const { imageUrl, background = "transparent" } = req.body;

    if (!imageUrl) {
      return res.status(400).json({ success: false, error: "imageUrl is required" });
    }
    if (!LIGHTX_API_KEY) {
      return res.status(500).json({ success: false, error: "LIGHTX_API_KEY is not set" });
    }

    // 1. Get file size + content type from Bubble URL
    const headResp = await axios.head(imageUrl, { validateStatus: () => true });
    if (headResp.status < 200 || headResp.status >= 300) {
      throw new Error(`Could not read image headers: HTTP ${headResp.status}`);
    }

    const size = parseInt(headResp.headers["content-length"]);
    const contentType = headResp.headers["content-type"] || "image/jpeg";

    // 2. Request LightX upload URL
    const uploadInit = await lightxPost("/uploadImageUrl", {
      uploadType: "imageUrl",
      size,
      contentType
    });

    const uploadUrl = uploadInit.body?.uploadImage;
    const finalImageUrl = uploadInit.body?.imageUrl;

    if (!uploadUrl || !finalImageUrl) {
      throw new Error("Invalid uploadImageUrl response from LightX");
    }

    // 3. Download image from Bubble
    const fileResp = await axios.get(imageUrl, {
      responseType: "arraybuffer",
      validateStatus: () => true
    });

    if (fileResp.status < 200 || fileResp.status >= 300) {
      throw new Error(`Failed to GET Bubble image: HTTP ${fileResp.status}`);
    }

    const fileBuffer = Buffer.from(fileResp.data);

    // 4. Upload to LightX S3
    const putResp = await axios.put(uploadUrl, fileBuffer, {
      headers: {
        "Content-Type": contentType,
        "Content-Length": fileBuffer.length
      },
      validateStatus: () => true
    });

    if (putResp.status < 200 || putResp.status >= 300) {
      throw new Error(
        `S3 upload failed: HTTP ${putResp.status} ${putResp.statusText}`
      );
    }

    // 5. Start background removal
    const removeResp = await lightxPost("/remove-background", {
      imageUrl: finalImageUrl,
      background
    });

    const orderId = removeResp.body?.orderId;
    const retries = removeResp.body?.maxRetriesAllowed ?? 5;

    if (!orderId) {
      throw new Error("No orderId returned from remove-background");
    }

    // 6. Poll status
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
        status,
        raw: statusResp
      });
    }

    return res.json({
      success: true,
      status,
      output: statusResp.body?.output
    });

  } catch (err) {
    console.error("Error in /lightx/remove-bg:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server listening on", PORT);
});
