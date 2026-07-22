(() => {
  "use strict";

  const TESTNET = "wss://s.altnet.rippletest.net:51233";
  let client = null;
  let wallet = null;
  let latestEscrow = null;
  let heartbeat = null;

  const $ = (id) => document.getElementById(id);
  const toast = (message, error=false) => {
    const el = $("toast");
    el.textContent = message;
    el.className = error ? "show error" : "show";
    clearTimeout(el.timer);
    el.timer = setTimeout(() => el.className = "", 4300);
  };
  const short = (value, n=10) => value ? `${value.slice(0,n)}…${value.slice(-6)}` : "—";
  const ensureXrpl = () => {
    if (!window.xrpl) throw new Error("xrpl.js did not load. Check your internet connection and refresh.");
  };
  const ensureWallet = () => {
    if (!wallet) throw new Error("Create a temporary Testnet wallet first.");
  };
  const rippleTime = (date) => xrpl.isoTimeToRippleTime(date.toISOString());

  async function connect() {
    ensureXrpl();
    const started = performance.now();
    if (client?.isConnected()) return client;
    client = new xrpl.Client(TESTNET);
    await client.connect();
    const info = await client.request({command:"server_info"});
    const ms = Math.round(performance.now() - started);
    const validated = info.result.info.validated_ledger || {};
    $("ledgerIndex").textContent = validated.seq ?? "—";
    $("baseFee").textContent = validated.base_fee_xrp ? `${validated.base_fee_xrp} XRP` : "—";
    $("serverVersion").textContent = info.result.info.build_version || "—";
    $("latency").textContent = `${ms} ms`;
    $("networkLamp").textContent = "OPERATIONAL";
    $("networkLamp").classList.add("online");
    $("heroNetwork").textContent = "XRPL TESTNET CONNECTED";
    toast("XRPL Testnet connection established.");
    clearInterval(heartbeat);
    heartbeat = setInterval(refreshTelemetry, 12000);
    return client;
  }

  async function refreshTelemetry() {
    if (!client?.isConnected()) return;
    try {
      const t = performance.now();
      const info = await client.request({command:"server_info"});
      $("latency").textContent = `${Math.round(performance.now()-t)} ms`;
      $("ledgerIndex").textContent = info.result.info.validated_ledger?.seq ?? "—";
      $("baseFee").textContent = info.result.info.validated_ledger?.base_fee_xrp ? `${info.result.info.validated_ledger.base_fee_xrp} XRP` : "—";
    } catch (_) {}
  }

  async function createWallet() {
    try {
      await connect();
      $("createWallet").disabled = true;
      $("createWallet").textContent = "CONTACTING TESTNET FAUCET...";
      const funded = await client.fundWallet();
      wallet = funded.wallet;
      $("walletAddress").textContent = wallet.address;
      $("walletSeed").textContent = wallet.seed || "Seed unavailable";
      $("walletBalance").textContent = `${funded.balance ?? await client.getXrpBalance(wallet.address)} XRP`;
      $("walletState").textContent = "FUNDED";
      $("walletState").classList.add("online");
      $("escrowOwner").value = wallet.address;
      toast("Temporary Testnet wallet created and funded.");
      await refreshHistory();
    } catch (err) {
      toast(err.message || "Could not fund Testnet wallet.", true);
      $("createWallet").disabled = false;
    } finally {
      $("createWallet").textContent = "Create New Test Wallet";
    }
  }

  function validateAddress(address, label) {
    if (!xrpl.isValidClassicAddress(address)) throw new Error(`${label} must be a valid XRPL classic address.`);
  }

  async function authorize(title, tx) {
    $("confirmTitle").textContent = title;
    $("confirmPayload").textContent = JSON.stringify(tx, null, 2);
    $("confirmDialog").showModal();
    return new Promise(resolve => {
      $("confirmDialog").addEventListener("close", () => resolve($("confirmDialog").returnValue === "confirm"), {once:true});
    });
  }

  async function submit(tx, title) {
    ensureWallet();
    await connect();
    const approved = await authorize(title, tx);
    if (!approved) throw new Error("Transaction authorization cancelled.");
    const prepared = await client.autofill(tx);
    const signed = wallet.sign(prepared);
    toast("Transaction submitted. Waiting for a validated ledger result...");
    const result = await client.submitAndWait(signed.tx_blob);
    const code = result.result.meta?.TransactionResult;
    if (code !== "tesSUCCESS") throw new Error(`Ledger result: ${code || "unknown"}`);
    return {result, prepared, hash:signed.hash};
  }

  async function createEscrow(event) {
    event.preventDefault();
    try {
      ensureWallet();
      const destination = $("destination").value.trim();
      validateAddress(destination, "Destination");
      if (destination === wallet.address) throw new Error("Use a different Testnet destination account.");
      const xrpAmount = Number($("amount").value);
      const finishSeconds = Number($("finishDelay").value);
      const cancelMinutes = Number($("cancelDelay").value);
      if (!(xrpAmount > 0)) throw new Error("Amount must be greater than zero.");
      if (finishSeconds < 30) throw new Error("Finish delay must be at least 30 seconds.");
      if (cancelMinutes * 60 <= finishSeconds) throw new Error("CancelAfter must occur after FinishAfter.");

      const now = new Date();
      const finish = new Date(now.getTime() + finishSeconds*1000);
      const cancel = new Date(now.getTime() + cancelMinutes*60000);
      const tx = {
        TransactionType:"EscrowCreate",
        Account:wallet.address,
        Destination:destination,
        Amount:xrpl.xrpToDrops(String(xrpAmount)),
        FinishAfter:rippleTime(finish),
        CancelAfter:rippleTime(cancel)
      };
      const submitted = await submit(tx, "Authorize EscrowCreate");
      latestEscrow = {
        owner:wallet.address,
        sequence:submitted.prepared.Sequence,
        hash:submitted.hash,
        finishAfter:finish.toISOString(),
        cancelAfter:cancel.toISOString()
      };
      $("offerSequence").textContent = latestEscrow.sequence;
      $("latestHash").textContent = latestEscrow.hash;
      $("manageSequence").value = latestEscrow.sequence;
      $("escrowOwner").value = wallet.address;
      toast(`Escrow created in validated ledger. Offer sequence: ${latestEscrow.sequence}`);
      await updateBalance();
      await refreshHistory();
    } catch (err) { toast(err.message, true); }
  }

  async function manageEscrow(type) {
    try {
      ensureWallet();
      const owner = $("escrowOwner").value.trim();
      const sequence = Number($("manageSequence").value);
      validateAddress(owner, "Escrow owner");
      if (!Number.isInteger(sequence) || sequence < 1) throw new Error("Enter a valid offer sequence.");
      const tx = {
        TransactionType:type,
        Account:wallet.address,
        Owner:owner,
        OfferSequence:sequence
      };
      const submitted = await submit(tx, `Authorize ${type}`);
      $("latestHash").textContent = submitted.hash;
      toast(`${type} validated successfully.`);
      await updateBalance();
      await refreshHistory();
    } catch (err) { toast(err.message, true); }
  }

  async function updateBalance() {
    if (!wallet || !client?.isConnected()) return;
    try { $("walletBalance").textContent = `${await client.getXrpBalance(wallet.address)} XRP`; } catch (_) {}
  }

  async function refreshHistory() {
    try {
      ensureWallet();
      await connect();
      const response = await client.request({
        command:"account_tx", account:wallet.address,
        ledger_index_min:-1, ledger_index_max:-1, limit:12, forward:false
      });
      const items = response.result.transactions || [];
      $("history").innerHTML = items.length ? items.map(item => {
        const tx = item.tx || item.tx_json || {};
        const hash = tx.hash || item.hash || "";
        const result = item.meta?.TransactionResult || item.meta?.transaction_result || "—";
        return `<article class="history-item">
          <strong>${escapeHtml(tx.TransactionType || "Transaction")}</strong>
          <code title="${escapeHtml(hash)}">${escapeHtml(short(hash,12))}</code>
          <span>${escapeHtml(result)} • Ledger ${escapeHtml(String(item.ledger_index || "—"))}</span>
        </article>`;
      }).join("") : `<p class="empty">No validated account transactions found yet.</p>`;
    } catch (err) { toast(err.message, true); }
  }

  const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

  // Digital apparition guide: scripted local guidance, not a remote AI service.
  const guideText = {
    wallet:"Select “Create & Fund Test Wallet.” The public XRPL Testnet faucet creates a disposable account. Its seed stays only in this browser session.",
    escrow:"EscrowCreate locks XRP in a ledger object. FinishAfter defines the earliest valid finish time. CancelAfter defines when cancellation becomes valid. XRPL validates those rules.",
    safety:"v2.001 is intentionally locked to Testnet. A public Mainnet launch requires secure external signing, production infrastructure, legal review, monitoring, and operational controls.",
    status:() => client?.isConnected()
      ? `The XRPL Testnet connection is operational. Validated ledger ${$("ledgerIndex").textContent}. Temporary wallet ${wallet ? "is ready" : "has not been created"}.`
      : "The network is currently disconnected. Use Connect to XRPL Testnet to begin."
  };
  function showGuide() { $("guideLayer").classList.add("active"); $("guideLayer").setAttribute("aria-hidden","false"); }
  function hideGuide() { $("guideLayer").classList.remove("active"); $("guideLayer").setAttribute("aria-hidden","true"); }

  // Particle field.
  const canvas = $("particleField"), ctx = canvas.getContext("2d");
  let particles = [];
  function sizeCanvas() {
    canvas.width = innerWidth * devicePixelRatio;
    canvas.height = innerHeight * devicePixelRatio;
    canvas.style.width = innerWidth+"px"; canvas.style.height = innerHeight+"px";
    ctx.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0);
    particles = Array.from({length:Math.min(100,Math.floor(innerWidth/14))},()=>({
      x:Math.random()*innerWidth,y:Math.random()*innerHeight,
      vx:(Math.random()-.5)*.24,vy:(Math.random()-.5)*.24,r:Math.random()*1.6+.3
    }));
  }
  function drawParticles() {
    ctx.clearRect(0,0,innerWidth,innerHeight);
    for (const p of particles) {
      p.x+=p.vx;p.y+=p.vy;
      if(p.x<0||p.x>innerWidth)p.vx*=-1;if(p.y<0||p.y>innerHeight)p.vy*=-1;
      ctx.beginPath();ctx.arc(p.x,p.y,p.r,0,Math.PI*2);ctx.fillStyle="rgba(62,218,255,.5)";ctx.fill();
    }
    for(let i=0;i<particles.length;i++) for(let j=i+1;j<particles.length;j++){
      const a=particles[i],b=particles[j],d=Math.hypot(a.x-b.x,a.y-b.y);
      if(d<110){ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.strokeStyle=`rgba(37,149,255,${.12*(1-d/110)})`;ctx.stroke()}
    }
    requestAnimationFrame(drawParticles);
  }

  $("connectNetwork").addEventListener("click",()=>connect().catch(e=>toast(e.message,true)));
  $("createWallet").addEventListener("click",createWallet);
  $("escrowForm").addEventListener("submit",createEscrow);
  $("finishEscrow").addEventListener("click",()=>manageEscrow("EscrowFinish"));
  $("cancelEscrow").addEventListener("click",()=>manageEscrow("EscrowCancel"));
  $("refreshHistory").addEventListener("click",refreshHistory);
  $("launchButton").addEventListener("click",()=>document.querySelector("#escrowLab").scrollIntoView());
  document.querySelectorAll("[data-scroll]").forEach(b=>b.addEventListener("click",()=>document.querySelector(b.dataset.scroll).scrollIntoView()));
  document.querySelectorAll("[data-copy]").forEach(b=>b.addEventListener("click",async()=>{
    const value = $(b.dataset.copy).textContent;
    if(value==="—") return toast("Nothing to copy yet.",true);
    await navigator.clipboard.writeText(value);toast("Copied.");
  }));
  $("summonGuide").addEventListener("click",showGuide);$("closeGuide").addEventListener("click",hideGuide);
  document.querySelectorAll("[data-guide]").forEach(b=>b.addEventListener("click",()=>{
    const answer=guideText[b.dataset.guide];$("guideMessage").textContent=typeof answer==="function"?answer():answer;
  }));
  addEventListener("resize",sizeCanvas);sizeCanvas();drawParticles();
  if("serviceWorker" in navigator) navigator.serviceWorker.register("./service-worker.js").catch(()=>{});
})();
