import { useState, useRef, useEffect } from "react";
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

  // Refs for WebRTC objects
  const wsRef = useRef(null);
  const pcRef = useRef(null);
  const dataChannelRef = useRef(null);
  const iceCandidateQueueRef = useRef([]);
  const roomCodeRef = useRef(null);
  const receivedMetadataRef = useRef(null);

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

  // Send File
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
      console.log("[SEND] Starting file send...");
      updateStatus("info", `Sending ${selectedFile.name}...`);

      const metadata = {
        name: selectedFile.name,
        size: selectedFile.size,
        type: selectedFile.type,
      };
      dataChannelRef.current.send(JSON.stringify({ metadata }));

      const buffer = await selectedFile.arrayBuffer();
      dataChannelRef.current.send(buffer);

      updateStatus(
        "success",
        `File sent successfully! (${(selectedFile.size / 1024).toFixed(2)} KB)`
      );
    } catch (error) {
      updateStatus("error", "Failed to send file: " + error.message);
    }
  };

  // Receive File
  const receiveFile = (event) => {
    console.log(
      "[RECEIVE] Got message, type:",
      typeof event.data,
      "size:",
      event.data.byteLength || event.data.length
    );
    try {
      if (!receivedMetadataRef.current) {
        console.log("[RECEIVE] Parsing metadata...");
        const data = JSON.parse(event.data);
        if (data.metadata) {
          receivedMetadataRef.current = data.metadata;
          updateStatus(
            "info",
            `Receiving ${receivedMetadataRef.current.name}...`
          );
          return;
        }
      }

      if (event.data instanceof ArrayBuffer) {
        const blob = new Blob([event.data], {
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
          `File received and downloaded! (${(blob.size / 1024).toFixed(2)} KB)`
        );

        setTimeout(() => URL.revokeObjectURL(url), 100);
        receivedMetadataRef.current = null;
      }
    } catch (error) {
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
        `Share code ${newCode} with receiver. Waiting for connection...`
      );
    } catch (error) {
      updateStatus("error", "Failed to initiate: " + error.message);
    }
  };

  // Receiver: Initiate Receive
  const initiateReceive = async () => {
    const inputCode = codeInput.trim();

    if (!inputCode || inputCode.length !== 6) {
      updateStatus("error", "Please enter a valid 6-digit code");
      return;
    }

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
      updateStatus("info", `Joined room ${inputCode}. Waiting for file...`);
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
          <strong>💡 New Flow:</strong>
          <br />
          <strong>Sender:</strong> Select file → Get 6-digit code → Share code
          <br />
          <strong>Receiver:</strong> Enter code → Download file instantly
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
            <input
              type="text"
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value)}
              placeholder="000000"
              maxLength="6"
              pattern="[0-9]{6}"
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
