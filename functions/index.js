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


const TOPUP_MILESTONES = [10000, 20000, 50000, 100000, 200000, 500000];

async function getEligibleTopupMilestones(uid) {
  const requestsSnap = await db.collection("topupRequests").where("uid", "==", uid).get();
  const approvedAmounts = requestsSnap.docs
    .filter(doc => doc.data().status === "reviewed")
    .map(doc => Number(doc.data().amount || 0))
    .filter(amount => Number.isSafeInteger(amount) && amount > 0);

  return approvedAmounts;
}

exports.getTopupMilestoneStatus = onCall({ region: "asia-southeast1" }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Vui lòng đăng nhập để xem mốc thưởng.");

  const uid = request.auth.uid;
  const approvedAmounts = await getEligibleTopupMilestones(uid);
  const claimsRef = db.collection("wallets").doc(uid).collection("topupMilestoneClaims");
  const claimsSnap = await claimsRef.get();
  const claimed = new Set(claimsSnap.docs.map(doc => Number(doc.id)));

  return {
    milestones: TOPUP_MILESTONES.map(amount => ({
      amount,
      bonus: amount,
      unlocked: approvedAmounts.some(approvedAmount => approvedAmount >= amount),
      claimed: claimed.has(amount)
    }))
  };
});

exports.claimTopupMilestone = onCall({ region: "asia-southeast1" }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Vui lòng đăng nhập để nhận thưởng.");

  const uid = request.auth.uid;
  const amount = Number(request.data && request.data.amount);
  if (!TOPUP_MILESTONES.includes(amount)) {
    throw new HttpsError("invalid-argument", "Mốc thưởng không hợp lệ.");
  }

  // Chỉ yêu cầu nạp đã được admin xác nhận mới đủ điều kiện mở khóa.
  const approvedAmounts = await getEligibleTopupMilestones(uid);
  if (!approvedAmounts.some(approvedAmount => approvedAmount >= amount)) {
    throw new HttpsError("failed-precondition", "Bạn chưa có giao dịch nạp được xác nhận đủ mốc này.");
  }

  const walletRef = db.collection("wallets").doc(uid);
  const claimRef = walletRef.collection("topupMilestoneClaims").doc(String(amount));
  const historyRef = db.collection("coinTransactions").doc();

  const result = await db.runTransaction(async tx => {
    const [walletSnap, claimSnap] = await Promise.all([
      tx.get(walletRef),
      tx.get(claimRef)
    ]);

    if (!walletSnap.exists) {
      throw new HttpsError("failed-precondition", "Không tìm thấy ví tài khoản.");
    }
    if (claimSnap.exists) {
      throw new HttpsError("already-exists", "Bạn đã nhận mốc thưởng này rồi.");
    }

    const wallet = walletSnap.data();
    const oldBalance = Number(wallet.coins || 0);
    const newBalance = oldBalance + amount;
    if (!Number.isSafeInteger(oldBalance) || !Number.isSafeInteger(newBalance)) {
      throw new HttpsError("failed-precondition", "Số dư ví không hợp lệ.");
    }

    const rankNames = ["Đồng", "Bạc", "Vàng", "Bạch Kim", "Kim Cương", "Tinh Anh", "Thách Đấu"];
    const rankNeeds = [20000, 70000, 200000, 500000, 700000, 3000000];
    let rankIndex = Math.max(0, Number(wallet.rankIndex || 0));
    let rankProgress = Math.max(0, Number(wallet.rankProgress || 0)) + amount;
    while (rankIndex < rankNeeds.length && rankProgress >= rankNeeds[rankIndex]) {
      rankProgress -= rankNeeds[rankIndex];
      rankIndex++;
    }

    tx.update(walletRef, {
      coins: newBalance,
      rank: rankNames[Math.min(rankIndex, rankNames.length - 1)],
      rankIndex,
      rankProgress,
      updatedAt: FieldValue.serverTimestamp()
    });
    tx.create(claimRef, {
      uid,
      milestone: amount,
      bonus: amount,
      claimedAt: FieldValue.serverTimestamp(),
      source: "topupX2"
    });
    tx.create(historyRef, {
      uid,
      userId: String(wallet.userId || ""),
      type: "add",
      amount,
      balanceAfter: newBalance,
      note: "Thưởng nạp X2 mốc " + amount.toLocaleString("vi-VN") + " Xu",
      source: "topupX2",
      createdAt: FieldValue.serverTimestamp()
    });

    return { amount, bonus: amount, balance: newBalance };
  });

  return result;
});

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


exports.deliverCloneAccounts = onCall({ region: "asia-southeast1" }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Vui lòng đăng nhập trước khi nhận tài khoản.");
  }

  const service = String(request.data && request.data.service || "");
  const level = service === "ACC CLONE LV0" ? "LV0" :
    service === "ACC CLONE LV12" ? "LV12" : "";
  const count = Number(request.data && request.data.count);
  const orderId = String(request.data && request.data.orderId || "");
  const date = String(request.data && request.data.date || "");

  if (!level) throw new HttpsError("invalid-argument", "Loại tài khoản không hợp lệ.");
  if (!Number.isSafeInteger(count) || count < 1 || count > 100) {
    throw new HttpsError("invalid-argument", "Số lượng tài khoản phải từ 1 đến 100.");
  }
  if (!/^VKL-[A-F0-9]{32}$/.test(orderId)) {
    throw new HttpsError("invalid-argument", "Mã đơn hàng không hợp lệ.");
  }

  const uid = request.auth.uid;
  const username = String(request.auth.token.email || "Khách hàng").split("@")[0];
  const orderRef = db.collection("orders").doc(orderId);
  const trackingRef = db.collection("orderTracking").doc(orderId);

  return db.runTransaction(async (tx) => {
    const existingOrder = await tx.get(orderRef);
    if (existingOrder.exists) {
      const existing = existingOrder.data();
      if (existing.userId !== uid) {
        throw new HttpsError("permission-denied", "Mã đơn hàng không thuộc tài khoản của bạn.");
      }
      if (existing.deliveryStatus === "Đã giao tài khoản") {
        return { orderId, delivered: Number(existing.deliveredAccountCount || count), alreadyProcessed: true };
      }
      throw new HttpsError("already-exists", "Mã đơn hàng đã được sử dụng.");
    }

    const stockQuery = db.collection("accInventory")
      .where("level", "==", level)
      .limit(count);
    const stock = await tx.get(stockQuery);

    if (stock.size < count) {
      throw new HttpsError(
        "failed-precondition",
        "Kho " + level + " hiện chỉ còn " + stock.size + " tài khoản. Vui lòng giảm số lượng."
      );
    }

    const accounts = stock.docs.map((doc) => {
      const data = doc.data();
      const account = String(data.account || "").trim();
      const password = String(data.password || "").trim();
      if (!account || !password || data.level !== level) {
        throw new HttpsError("failed-precondition", "Có tài khoản trong kho bị thiếu thông tin. Vui lòng kiểm tra kho.");
      }
      return { account, password };
    });

    // Xóa kho và ghi đơn + thông tin giao trong cùng transaction để không phát trùng.
    stock.docs.forEach((doc) => tx.delete(doc.ref));

    for (let offset = 0, index = 0; offset < accounts.length; offset += 20, index++) {
      const chunk = accounts.slice(offset, offset + 20);
      const chunkRef = orderRef.collection("deliveredAccounts").doc(String(index).padStart(3, "0"));
      tx.create(chunkRef, { index, accounts: chunk, createdAt: FieldValue.serverTimestamp() });
    }

    tx.create(orderRef, {
      userId: uid,
      username,
      service,
      count,
      quantity: count,
      total: 0,
      codes: "",
      date: date.slice(0, 80),
      label: "Số lượng tài khoản",
      deliveryStatus: "Đã giao tài khoản",
      deliveredAccountCount: accounts.length,
      createdAt: FieldValue.serverTimestamp(),
      deliveredAt: FieldValue.serverTimestamp(),
      source: "automaticInventory"
    });

    tx.create(trackingRef, {
      userId: uid,
      service,
      status: "Đã giao tài khoản",
      progress: 100,
      eta: "Đã giao",
      note: "Hệ thống đã tự động giao " + accounts.length + " tài khoản từ kho " + level + ".",
      updatedAt: FieldValue.serverTimestamp()
    });

    return { orderId, delivered: accounts.length, alreadyProcessed: false };
  });
});
