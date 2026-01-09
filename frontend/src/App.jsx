import { useState, useRef, useEffect } from "react";
import CryptoJS from "crypto-js";
import "./App.css";

function App() {
  // WebRTC Configuration
  const config = {
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  };

  // State
  const [signalingUrl, setSignalingUrl] = useState(
    import.meta.env.VITE_WS_URL || "ws://localhost:8080"
  );
  const [role, setRole] = useState(null);
  const [selectedFile, setSelectedFile] = useState(null);
  const [status, setStatus] = useState({ type: "", message: "" });
  const [code, setCode] = useState("000000");
  const [showCode, setShowCode] = useState(false);
  const [codeInput, setCodeInput] = useState("");
  const [sendBtnDisabled, setSendBtnDisabled] = useState(true);
  const [joinBtnDisabled, setJoinBtnDisabled] = useState(false);
  const [encryptionKey, setEncryptionKey] = useState("");
  const [keyInput, setKeyInput] = useState("");

  // Ref to store the encryption key for receiver
  const decryptionKeyRef = useRef(null);

  // Generate a random 256-bit (32 bytes) key as hex string
  const generateEncryptionKey = () => {
    const key = CryptoJS.lib.WordArray.random(32).toString(CryptoJS.enc.Hex);
    return key;
  };

  // Encrypt data using AES-256
  const encryptData = (keyHex, arrayBuffer) => {
    // Convert ArrayBuffer to WordArray
    const wordArray = CryptoJS.lib.WordArray.create(
      new Uint8Array(arrayBuffer)
    );
    // Parse key from hex
    const key = CryptoJS.enc.Hex.parse(keyHex);
    // Generate random IV
    const iv = CryptoJS.lib.WordArray.random(16);
    // Encrypt
    const encrypted = CryptoJS.AES.encrypt(wordArray, key, {
      iv: iv,
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7,
    });
    // Combine IV + ciphertext as base64
    const combined = iv.concat(encrypted.ciphertext);
    return combined.toString(CryptoJS.enc.Base64);
  };

  // Decrypt data using AES-256
  const decryptData = (keyHex, encryptedBase64) => {
    try {
      // Parse key from hex
      const key = CryptoJS.enc.Hex.parse(keyHex);
      // Decode base64 to get IV + ciphertext
      const combined = CryptoJS.enc.Base64.parse(encryptedBase64);
      // Extract IV (first 16 bytes = 4 words)
      const iv = CryptoJS.lib.WordArray.create(combined.words.slice(0, 4), 16);
      // Extract ciphertext (rest)
      const ciphertext = CryptoJS.lib.WordArray.create(
        combined.words.slice(4),
        combined.sigBytes - 16
      );
      // Decrypt
      const decrypted = CryptoJS.AES.decrypt({ ciphertext: ciphertext }, key, {
        iv: iv,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7,
      });
      // Convert WordArray back to Uint8Array
      const decryptedArray = wordArrayToUint8Array(decrypted);
      return decryptedArray;
    } catch (error) {
      throw new Error("Decryption failed. Invalid key.");
    }
  };

  // Helper: Convert WordArray to Uint8Array
  const wordArrayToUint8Array = (wordArray) => {
    const len = wordArray.sigBytes;
    const words = wordArray.words;
    const result = new Uint8Array(len);
    let offset = 0;
    for (let i = 0; i < len; i++) {
      const byte = (words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff;
      result[offset++] = byte;
    }
    return result;
  };

  // Refs for WebRTC objects
  const wsRef = useRef(null);
  const pcRef = useRef(null);
  const dataChannelRef = useRef(null);
  const iceCandidateQueueRef = useRef([]);
  const roomCodeRef = useRef(null);
  const receivedMetadataRef = useRef(null);
  const encryptionKeyRef = useRef(null);
  const receivedChunksRef = useRef([]);
  const expectedChunksRef = useRef(0);

  // Chunk size for sending (64KB to stay under WebRTC limit)
  const CHUNK_SIZE = 64 * 1024;

  // Generate 6-digit code
  const generateCode = () => {
    return Math.floor(100000 + Math.random() * 900000).toString();
  };

  // Update Status
  const updateStatus = (type, message) => {
    setStatus({ type, message });
    console.log(`[${type.toUpperCase()}] ${message}`);
  };

  // Role Selection
  const selectRole = (selectedRole) => {
    setRole(selectedRole);
    updateStatus("info", `Role selected: ${selectedRole.toUpperCase()}`);
  };

  // File Selection
  const handleFileSelect = (event) => {
    const file = event.target.files[0];
    setSelectedFile(file);

    if (file) {
      const sizeMB = (file.size / (1024 * 1024)).toFixed(2);
      setSendBtnDisabled(false);

      if (file.size > 1024 * 1024) {
        updateStatus(
          "warning",
          `File is ${sizeMB} MB. Large files may take longer. Recommended: <1 MB`
        );
      }
    }
  };

  // WebSocket Connection
  const connectWebSocket = (code) => {
    return new Promise((resolve, reject) => {
      updateStatus("info", "Connecting to signaling server...");

      const ws = new WebSocket(signalingUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        roomCodeRef.current = code;
        ws.send(JSON.stringify({ type: "join", room: code }));
      };

      ws.onerror = (error) => {
        updateStatus(
          "error",
          "Failed to connect to signaling server. Check URL and ensure server is running."
        );
        reject(error);
      };

      ws.onmessage = async (event) => {
        const data = JSON.parse(event.data);

        if (data.type === "joined") {
          console.log("[WEBSOCKET] Joined room:", data.room);
          updateStatus("success", `Connected to room ${code} ✓`);
          resolve();
          return;
        }

        if (data.type === "peer_ready") {
          console.log("[WEBSOCKET] Peer is ready, sending offer...");
          if (role === "sender") {
            const offer = await pcRef.current.createOffer();
            await pcRef.current.setLocalDescription(offer);
            console.log("[SENDER] Sending offer:", offer);
            sendSignaling(offer);
          }
          return;
        }

        await handleSignalingMessage(data);
      };

      ws.onclose = () => {
        updateStatus("warning", "Disconnected from signaling server");
      };
    });
  };

  // Signaling Message Handler
  const handleSignalingMessage = async (data) => {
    console.log("[SIGNALING] Received message:", data.type || "ICE candidate");
    if (!pcRef.current) {
      console.warn("[SIGNALING] No peer connection yet, ignoring");
      return;
    }

    try {
      if (data.type === "offer") {
        console.log("[SIGNALING] Processing offer, role=", role);
        if (role !== "receiver") {
          console.log("Ignoring offer - I am the sender");
          return;
        }
        await pcRef.current.setRemoteDescription(
          new RTCSessionDescription(data)
        );

        while (iceCandidateQueueRef.current.length > 0) {
          const candidate = iceCandidateQueueRef.current.shift();
          await pcRef.current.addIceCandidate(new RTCIceCandidate(candidate));
        }

        const answer = await pcRef.current.createAnswer();
        await pcRef.current.setLocalDescription(answer);
        sendSignaling(answer);
        updateStatus("info", "Received offer, sent answer");
      } else if (data.type === "answer") {
        if (role !== "sender") {
          console.log("Ignoring answer - I am the receiver");
          return;
        }
        await pcRef.current.setRemoteDescription(
          new RTCSessionDescription(data)
        );

        while (iceCandidateQueueRef.current.length > 0) {
          const candidate = iceCandidateQueueRef.current.shift();
          await pcRef.current.addIceCandidate(new RTCIceCandidate(candidate));
        }

        updateStatus("info", "Received answer, connection establishing...");
      } else if (data.candidate) {
        if (!pcRef.current.remoteDescription) {
          iceCandidateQueueRef.current.push(data);
        } else {
          await pcRef.current.addIceCandidate(new RTCIceCandidate(data));
        }
      }
    } catch (error) {
      console.error("Error handling signaling message:", error);
      updateStatus("error", "Signaling error: " + error.message);
    }
  };

  // Send Signaling Message
  const sendSignaling = (message) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    }
  };

  // Initialize Peer Connection
  const initPeerConnection = () => {
    const pc = new RTCPeerConnection(config);
    pcRef.current = pc;

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignaling(event.candidate);
      }
    };

    pc.onconnectionstatechange = () => {
      updateStatus("info", `Connection state: ${pc.connectionState}`);

      if (pc.connectionState === "connected") {
        updateStatus("success", "P2P connection established ✓");
      } else if (pc.connectionState === "failed") {
        updateStatus("error", "Connection failed. Check network/firewall.");
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log("ICE connection state:", pc.iceConnectionState);
    };
  };

  // Setup DataChannel Event Handlers
  const setupDataChannelHandlers = () => {
    console.log("[DATACHANNEL] Setting up handlers, role=", role);

    dataChannelRef.current.onopen = () => {
      console.log("[DATACHANNEL] Channel opened! role=", role);
      updateStatus("success", "DataChannel opened ✓");

      if (role === "sender") {
        console.log("[DATACHANNEL] Sender - calling sendFile()");
        sendFile();
      } else {
        console.log("[DATACHANNEL] Receiver - waiting for file");
      }
    };

    dataChannelRef.current.onclose = () => {
      updateStatus("info", "DataChannel closed");
    };

    dataChannelRef.current.onerror = (error) => {
      updateStatus("error", "DataChannel error: " + error);
    };

    if (role === "receiver") {
      dataChannelRef.current.onmessage = receiveFile;
    }
  };

  // Send File (encrypted with chunking)
  const sendFile = async () => {
    console.log(
      "[SEND] sendFile() called, file:",
      selectedFile?.name,
      "channel ready:",
      dataChannelRef.current?.readyState
    );
    if (!selectedFile || !dataChannelRef.current) {
      updateStatus("error", "Cannot send: no file or channel not ready");
      return;
    }

    try {
      console.log("[SEND] Starting encrypted file send...");
      updateStatus("info", `Encrypting ${selectedFile.name}...`);

      const buffer = await selectedFile.arrayBuffer();
      console.log("[SEND] File buffer size:", buffer.byteLength);

      // Encrypt the file data (returns base64 string)
      console.log(
        "[SEND] Encrypting with key:",
        encryptionKeyRef.current?.substring(0, 8) + "..."
      );
      const encryptedBase64 = encryptData(encryptionKeyRef.current, buffer);
      console.log("[SEND] Encrypted data length:", encryptedBase64.length);

      // Calculate number of chunks
      const totalChunks = Math.ceil(encryptedBase64.length / CHUNK_SIZE);
      console.log("[SEND] Total chunks to send:", totalChunks);

      const metadata = {
        name: selectedFile.name,
        size: selectedFile.size,
        type: selectedFile.type,
        encrypted: true,
        totalChunks: totalChunks,
        encryptedSize: encryptedBase64.length,
      };
      console.log("[SEND] Sending metadata:", metadata);
      dataChannelRef.current.send(JSON.stringify({ metadata }));

      // Small delay to ensure metadata is processed first
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Send chunks
      for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, encryptedBase64.length);
        const chunk = encryptedBase64.slice(start, end);

        // Wait for buffer to drain if needed
        while (dataChannelRef.current.bufferedAmount > 1024 * 1024) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        dataChannelRef.current.send(JSON.stringify({ chunk, index: i }));

        if ((i + 1) % 10 === 0 || i === totalChunks - 1) {
          updateStatus(
            "info",
            `Sending... ${Math.round(((i + 1) / totalChunks) * 100)}%`
          );
        }
      }

      console.log("[SEND] All chunks sent!");
      dataChannelRef.current.send(JSON.stringify({ complete: true }));

      updateStatus(
        "success",
        `Encrypted file sent successfully! (${(
          selectedFile.size / 1024
        ).toFixed(2)} KB)`
      );
    } catch (error) {
      console.error("[SEND] Error:", error);
      updateStatus("error", "Failed to send file: " + error.message);
    }
  };

  // Receive File (decrypt if encrypted, with chunking support)
  const receiveFile = (event) => {
    try {
      const data = JSON.parse(event.data);

      // First message: metadata
      if (data.metadata) {
        console.log("[RECEIVE] Got metadata:", data.metadata);
        receivedMetadataRef.current = data.metadata;
        receivedChunksRef.current = new Array(data.metadata.totalChunks);
        expectedChunksRef.current = data.metadata.totalChunks;
        updateStatus(
          "info",
          `Receiving ${receivedMetadataRef.current.name}...`
        );
        return;
      }

      // Chunk message
      if (data.chunk !== undefined && data.index !== undefined) {
        receivedChunksRef.current[data.index] = data.chunk;
        const received = receivedChunksRef.current.filter(
          (c) => c !== undefined
        ).length;
        if (received % 10 === 0 || received === expectedChunksRef.current) {
          updateStatus(
            "info",
            `Receiving... ${Math.round(
              (received / expectedChunksRef.current) * 100
            )}%`
          );
        }
        return;
      }

      // Complete message - reassemble and decrypt
      if (data.complete) {
        console.log("[RECEIVE] All chunks received, reassembling...");
        const encryptedBase64 = receivedChunksRef.current.join("");
        console.log("[RECEIVE] Reassembled size:", encryptedBase64.length);

        let fileData;
        if (decryptionKeyRef.current) {
          updateStatus("info", "Decrypting file...");
          try {
            fileData = decryptData(decryptionKeyRef.current, encryptedBase64);
            console.log(
              "[RECEIVE] Decryption successful, size:",
              fileData.length
            );
          } catch (decryptError) {
            console.error("[RECEIVE] Decryption error:", decryptError);
            updateStatus("error", "Decryption failed. Invalid key.");
            receivedMetadataRef.current = null;
            receivedChunksRef.current = [];
            return;
          }
        } else {
          console.error("[RECEIVE] No decryption key available");
          updateStatus("error", "No decryption key available");
          return;
        }

        const blob = new Blob([fileData], {
          type: receivedMetadataRef.current?.type || "application/octet-stream",
        });
        const url = URL.createObjectURL(blob);

        const a = document.createElement("a");
        a.href = url;
        a.download = receivedMetadataRef.current?.name || "received_file";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        updateStatus(
          "success",
          `File decrypted and downloaded! (${(blob.size / 1024).toFixed(2)} KB)`
        );

        setTimeout(() => URL.revokeObjectURL(url), 100);
        receivedMetadataRef.current = null;
        receivedChunksRef.current = [];
      }
    } catch (error) {
      console.error("[RECEIVE] Error:", error);
      updateStatus("error", "Failed to receive file: " + error.message);
    }
  };

  // Sender: Initiate Send
  const initiateSend = async () => {
    if (!selectedFile) {
      updateStatus("error", "No file selected");
      return;
    }

    try {
      const newCode = generateCode();
      setCode(newCode);
      setShowCode(true);
      setSendBtnDisabled(true);

      // Generate encryption key (hex string)
      const key = generateEncryptionKey();
      encryptionKeyRef.current = key;
      setEncryptionKey(key);

      await connectWebSocket(newCode);
      console.log("[SENDER] Room joined, creating peer connection");
      initPeerConnection();

      dataChannelRef.current = pcRef.current.createDataChannel("file", {
        ordered: true,
      });
      dataChannelRef.current.binaryType = "arraybuffer";

      setupDataChannelHandlers();

      console.log("[SENDER] Waiting for receiver to join...");

      updateStatus(
        "info",
        `Share code ${newCode} and encryption key with receiver. Waiting for connection...`
      );
    } catch (error) {
      updateStatus("error", "Failed to initiate: " + error.message);
    }
  };

  // Receiver: Initiate Receive
  const initiateReceive = async () => {
    const inputCode = codeInput.trim();
    const inputKey = keyInput.trim();

    if (!inputCode || inputCode.length !== 6) {
      updateStatus("error", "Please enter a valid 6-digit code");
      return;
    }

    if (!inputKey) {
      updateStatus("error", "Please enter the encryption key");
      return;
    }

    // Validate the key format (should be 64 hex characters for 256-bit key)
    if (!/^[0-9a-fA-F]{64}$/.test(inputKey)) {
      updateStatus(
        "error",
        "Invalid encryption key format (expected 64 hex characters)"
      );
      return;
    }

    // Store the decryption key
    decryptionKeyRef.current = inputKey;

    try {
      setJoinBtnDisabled(true);

      await connectWebSocket(inputCode);
      console.log("[RECEIVER] Room joined, creating peer connection");
      initPeerConnection();

      pcRef.current.ondatachannel = (event) => {
        console.log("[RECEIVER] DataChannel received!");
        dataChannelRef.current = event.channel;
        dataChannelRef.current.binaryType = "arraybuffer";
        setupDataChannelHandlers();
        updateStatus("info", "DataChannel received from sender");
      };

      console.log("[RECEIVER] Ready and waiting for offer...");
      sendSignaling({ type: "peer_ready" });
      updateStatus(
        "info",
        `Joined room ${inputCode}. Waiting for encrypted file...`
      );
    } catch (error) {
      updateStatus("error", "Failed to initiate: " + error.message);
      setJoinBtnDisabled(false);
    }
  };

  return (
    <div className="body-wrapper">
      <div className="container">
        <div className="header">
          <div className="logo">⚡</div>
          <h1>Fluxion</h1>
          <p className="subtitle">Web-RTC based Instant P2P File Transfer</p>
        </div>

        <div className="config-section">
          <label htmlFor="signalingUrl">Signaling Server URL:</label>
          <input
            type="text"
            id="signalingUrl"
            value={signalingUrl}
            onChange={(e) => setSignalingUrl(e.target.value)}
            placeholder="ws://172.16.46.114:8080"
          />
        </div>

        <div className="info-box">
          <strong>💡 Encrypted File Transfer:</strong>
          <br />
          <strong>Sender:</strong> Select file → Get code + encryption key →
          Share both
          <br />
          <strong>Receiver:</strong> Enter code + key → Decrypt & download file
        </div>

        <div className="role-selection">
          <button
            className={`role-btn ${role === "sender" ? "active" : ""}`}
            onClick={() => selectRole("sender")}
          >
            <span>
              <span className="role-icon">↑</span>
              Send
            </span>
          </button>
          <button
            className={`role-btn ${role === "receiver" ? "active" : ""}`}
            onClick={() => selectRole("receiver")}
          >
            <span>
              <span className="role-icon">↓</span>
              Receive
            </span>
          </button>
        </div>

        <div className={`sender-section ${role === "sender" ? "active" : ""}`}>
          <div className="file-input-wrapper">
            <label
              htmlFor="fileInput"
              className={`file-input-label ${selectedFile ? "has-file" : ""}`}
            >
              {selectedFile ? (
                <>
                  <span className="file-icon">✓</span>
                  <span className="file-name">{selectedFile.name}</span>
                  <span className="file-size">
                    {(selectedFile.size / (1024 * 1024)).toFixed(2)} MB
                  </span>
                </>
              ) : (
                <>
                  <span className="file-icon">📁</span>
                  <span className="file-text">
                    Drop file here or click to browse
                  </span>
                  <span className="file-subtext">Any file type supported</span>
                </>
              )}
            </label>
            <input type="file" id="fileInput" onChange={handleFileSelect} />
          </div>
          <button
            className="btn btn-primary"
            onClick={initiateSend}
            disabled={sendBtnDisabled}
          >
            <span>Generate Share Code</span>
          </button>

          <div
            className="code-display"
            style={{ display: showCode ? "block" : "none" }}
          >
            <div className="code-label">Share this code</div>
            <div className="code-value">{code}</div>
            <div className="code-label" style={{ marginTop: "16px" }}>
              Encryption Key (share securely)
            </div>
            <div style={{ position: "relative" }}>
              <div
                className="key-value"
                style={{
                  fontSize: "12px",
                  wordBreak: "break-all",
                  backgroundColor: "#1a1a2e",
                  padding: "12px",
                  paddingRight: "50px",
                  borderRadius: "8px",
                  fontFamily: "monospace",
                  color: "#00d4ff",
                  userSelect: "all",
                  cursor: "text",
                }}
              >
                {encryptionKey}
              </div>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(encryptionKey);
                  updateStatus(
                    "success",
                    "Encryption key copied to clipboard!"
                  );
                }}
                style={{
                  position: "absolute",
                  right: "8px",
                  top: "50%",
                  transform: "translateY(-50%)",
                  background: "#00d4ff",
                  border: "none",
                  borderRadius: "4px",
                  padding: "6px 10px",
                  cursor: "pointer",
                  fontSize: "12px",
                  color: "#000",
                  fontWeight: "bold",
                }}
                title="Copy key"
              >
                📋
              </button>
            </div>
            <div className="code-status">
              <span className="waiting-dot"></span>
              <span className="waiting-dot"></span>
              <span className="waiting-dot"></span>
              <span style={{ marginLeft: "4px" }}>Waiting for receiver</span>
            </div>
          </div>
        </div>

        <div
          className={`receiver-section ${role === "receiver" ? "active" : ""}`}
        >
          <div className="code-input-wrapper">
            <label
              style={{
                color: "#888",
                fontSize: "12px",
                marginBottom: "4px",
                display: "block",
              }}
            >
              6-Digit Code
            </label>
            <input
              type="text"
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value)}
              placeholder="000000"
              maxLength="6"
              pattern="[0-9]{6}"
            />
          </div>
          <div className="code-input-wrapper" style={{ marginTop: "12px" }}>
            <label
              style={{
                color: "#888",
                fontSize: "12px",
                marginBottom: "4px",
                display: "block",
              }}
            >
              Encryption Key
            </label>
            <input
              type="text"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder="Paste encryption key here"
              style={{ fontSize: "12px", fontFamily: "monospace" }}
            />
          </div>
          <button
            className="btn btn-primary"
            onClick={initiateReceive}
            disabled={joinBtnDisabled}
          >
            <span>Connect & Download</span>
          </button>
        </div>

        {status.message && (
          <div className={`status ${status.type}`}>
            <span className="status-icon">
              {status.type === "success" && "✓"}
              {status.type === "error" && "✕"}
              {status.type === "warning" && "⚠"}
              {status.type === "info" && "ℹ"}
            </span>
            <span>{status.message}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
