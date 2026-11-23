const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

initializeApp();
const db = getFirestore();
const ADMIN_EMAIL = "haphamngu123@gmail.com";
const SETTINGS_PATH = "siteSettings/luckyWheel";

function vietnamDateKey() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return values.year + "-" + values.month + "-" + values.day;
}

function parsePrizes(raw) {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 12) {
    throw new HttpsError("failed-precondition", "Danh sách phần thưởng chưa hợp lệ.");
  }
  const prizes = raw.map((item) => {
    const text = String(item);
    const cut = text.lastIndexOf("|");
    if (cut < 1) throw new HttpsError("failed-precondition", "Cấu hình phần thưởng thiếu tỷ lệ.");
    const label = text.slice(0, cut).trim();
    const weight = Number(text.slice(cut + 1).trim());
    if (!label || !Number.isFinite(weight) || weight <= 0 || weight > 100) {
      throw new HttpsError("failed-precondition", "Tên hoặc tỷ lệ phần thưởng không hợp lệ.");
    }
    const match = label.match(/^([0-9][0-9.,]*)\s*Xu$/i);
    const coins = match ? Number(match[1].replace(/[.,]/g, "")) : 0;
    return { label, weight, coins: Number.isSafeInteger(coins) ? coins : 0 };
  });
  const total = prizes.reduce((sum, p) => sum + p.weight, 0);
  if (Math.abs(total - 100) > 0.0001) {
    throw new HttpsError("failed-precondition", "Tổng tỷ lệ phần thưởng phải bằng 100%.");
  }
  return prizes;
}

exports.spinLuckyWheel = onCall({ region: "asia-southeast1" }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Vui lòng đăng nhập để quay.");
  const uid = request.auth.uid;
  const email = String(request.auth.token.email || "").toLowerCase();
  const isAdmin = email === ADMIN_EMAIL && request.auth.token.email_verified === true;

  const requestId = String(request.data && request.data.requestId || "");
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(requestId)) {
    throw new HttpsError("invalid-argument", "Mã lượt quay không hợp lệ.");
  }
  const spinId = isAdmin ? uid + "_admin_" + requestId : uid + "_" + vietnamDateKey();

  const settingsRef = db.doc(SETTINGS_PATH);
  const spinRef = db.collection("luckyWheelSpins").doc(spinId);
  const walletRef = db.collection("wallets").doc(uid);

  return db.runTransaction(async (tx) => {
    const settingsSnap = await tx.get(settingsRef);
    if (!settingsSnap.exists) throw new HttpsError("failed-precondition", "Chưa có cấu hình vòng quay.");
    const prizes = parsePrizes(settingsSnap.data().prizes);
    const spinSnap = await tx.get(spinRef);
    if (spinSnap.exists) throw new HttpsError("already-exists", isAdmin ? "Lượt quay này đã được xử lý." : "Bạn đã quay hôm nay rồi.");
    if (!isAdmin && settingsSnap.data().freeDailyEnabled === false) {
      throw new HttpsError("failed-precondition", "Lượt quay miễn phí hôm nay đang tạm khóa.");
    }
    const walletSnap = await tx.get(walletRef);
    const currentCoins = walletSnap.exists && Number.isFinite(Number(walletSnap.data().coins))
      ? Number(walletSnap.data().coins) : 0;

    let roll = Math.random() * 100;
    let prizeIndex = prizes.length - 1;
    for (let i = 0; i < prizes.length; i++) {
      roll -= prizes[i].weight;
      if (roll < 0) { prizeIndex = i; break; }
    }
    const selected = prizes[prizeIndex];
    const newCoins = currentCoins + selected.coins;
    const date = vietnamDateKey();

    tx.create(spinRef, {
      uid,
      prize: selected.label,
      prizeIndex,
      coinsAwarded: selected.coins,
      balanceAfter: newCoins,
      date,
      createdAt: FieldValue.serverTimestamp(),
      source: "luckyWheel"
    });
    if (selected.coins > 0) {
      tx.set(walletRef, {
        coins: newCoins,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    }
    return {
      prize: selected.label,
      prizeIndex,
      coinsAwarded: selected.coins,
      balance: newCoins,
      date
    };
  });
});


exports.getLuckyWheelStatus = onCall({ region: "asia-southeast1" }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Vui lòng đăng nhập.");
  const uid = request.auth.uid;
  const email = String(request.auth.token.email || "").toLowerCase();
  const isAdmin = email === ADMIN_EMAIL && request.auth.token.email_verified === true;
  if (isAdmin) return { isAdmin: true, remaining: 0, dailyUsed: false, freeDailyEnabled: true };
  const [dailySnap, settingsSnap] = await Promise.all([
    db.collection("luckyWheelSpins").doc(uid + "_" + vietnamDateKey()).get(),
    db.doc(SETTINGS_PATH).get()
  ]);
  return {
    isAdmin: false,
    remaining: 0,
    dailyUsed: dailySnap.exists,
    freeDailyEnabled: !(settingsSnap.exists && settingsSnap.data().freeDailyEnabled === false)
  };
});
