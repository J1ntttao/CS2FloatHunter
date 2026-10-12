(function (global) {
  const root = global.CS2UPCore || (global.CS2UPCore = {});
  const AUTH_TOKEN_KEY = "csgoup_auth_token_v1";
  const AUTH_USER_KEY = "csgoup_auth_user_v1";

  function getSessionToken() {
    try {
      return (localStorage.getItem(AUTH_TOKEN_KEY) || "").trim();
    } catch {
      return "";
    }
  }

  function setSessionToken(token) {
    try {
      if (token) {
        localStorage.setItem(AUTH_TOKEN_KEY, token);
      } else {
        localStorage.removeItem(AUTH_TOKEN_KEY);
        localStorage.removeItem(AUTH_USER_KEY);
      }
    } catch {}
  }

  function getCachedAuthUser() {
    try {
      const raw = localStorage.getItem(AUTH_USER_KEY);
      return raw ? normalizeAuthUser(JSON.parse(raw)) : null;
    } catch {
      return null;
    }
  }

  function setCachedAuthUser(user) {
    try {
      const normalized = normalizeAuthUser(user);
      if (normalized) {
        localStorage.setItem(AUTH_USER_KEY, JSON.stringify(normalized));
      } else {
        localStorage.removeItem(AUTH_USER_KEY);
      }
    } catch {}
  }

  function isAuthExpiredError(error) {
    const status = Number(error?.status || 0);
    return status === 401 || status === 403;
  }

  function normalizeAuthUser(user) {
    if (!user || typeof user !== "object") return null;
    const username = String(user.username || "").trim();
    if (!username) return null;
    const exp = Number(user.subscription_expires_at || 0);
    const softwareExp = Number(user.software_subscription_expires_at || 0);
    const now = Math.floor(Date.now() / 1000);
    return {
      id: user.id,
      username,
      wechat_bound: Boolean(user.wechat_bound),
      wechat_nickname: String(user.wechat_nickname || "").trim(),
      avatar_url: String(user.avatar_url || "").trim(),
      invite_code: String(user.invite_code || "").trim(),
      referral_stats: user.referral_stats && typeof user.referral_stats === "object" ? user.referral_stats : {},
      subscription_expires_at: Number.isFinite(exp) ? exp : 0,
      subscription_active: Number.isFinite(exp) ? exp > now : false,
      software_subscription_expires_at: Number.isFinite(softwareExp) ? softwareExp : 0,
      software_subscription_active: Number.isFinite(softwareExp) ? softwareExp > now : false,
    };
  }

  async function apiRequest(path, { method = "GET", body = null, auth = true, signal = undefined } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (auth) {
      const token = getSessionToken();
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    const resp = await fetch(path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });

    let data = {};
    try {
      data = await resp.json();
    } catch {
      data = {};
    }

    if (!resp.ok || data.ok === false) {
      const error = new Error(data.error || `请求失败 (${resp.status})`);
      error.status = resp.status;
      error.code = data.code || "";
      error.payload = data;
      throw error;
    }
    return data;
  }

  root.api = {
    AUTH_TOKEN_KEY,
    AUTH_USER_KEY,
    getSessionToken,
    setSessionToken,
    getCachedAuthUser,
    setCachedAuthUser,
    isAuthExpiredError,
    normalizeAuthUser,
    apiRequest,
  };

  if (!document.querySelector('script[data-cs2up-wechat-auth]')) {
    const script = document.createElement("script");
    script.src = "/js/core/wechat-auth.js?v=20260731-default-referral-1";
    script.defer = true;
    script.dataset.cs2upWechatAuth = "1";
    document.head.appendChild(script);
  }
})(window);
