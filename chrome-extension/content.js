(function() {
  /**
    * Endurance Profiles for BRouter/bikerouter
    *
    * Executes in the MAIN world to intercept fetch/XHR.
    * This is required to upload large custom profiles directly to the /profile endpoint,
    * bypassing the 414 Request-URI Too Large error on long URLs.
  */

  console.log("[Endurance Extension] Activated.");

  const baseProfilesUrl = 'https://raw.githubusercontent.com/seriych/BRouter-Endurance-Profiles/refs/heads/master';
  const ENDURANCE_PROFILES = {
    'Endurance-Adventure': `${baseProfilesUrl}/Endurance-Adventure.brf`,
    'Endurance-Explore': `${baseProfilesUrl}/Endurance-Explore.brf`,
    'Endurance': `${baseProfilesUrl}/Endurance.brf`,
    'Endurance-Direct': `${baseProfilesUrl}/Endurance-Direct.brf`,
    'Endurance-Express': `${baseProfilesUrl}/Endurance-Express.brf`
  };

  const CACHE_TTL = 2 * 60 * 60 * 1000; // 2 hour cache lifetime

  const cachedTexts = {};
  const serverProfileIds = {};

  // Synchronous cache boot to prevent race conditions on direct URL state loads
  Object.keys(ENDURANCE_PROFILES).forEach(name => {
    const cachedText = localStorage.getItem(`endurance_cache_${name}`);
    if (cachedText) {
      cachedTexts[name] = cachedText;
    }
  });

  const nativeFetch = window.fetch;

  // Background non-blocking update checking. Restricted strictly to the author's public repository.
  Object.entries(ENDURANCE_PROFILES).forEach(([name, url]) => {
    const cacheKey = `endurance_cache_${name}`;
    const timeKey = `endurance_cache_time_${name}`;
    const cachedTime = localStorage.getItem(timeKey);
    const now = Date.now();

    if (!cachedTexts[name] || !cachedTime || (now - parseInt(cachedTime, 10) >= CACHE_TTL)) {
      nativeFetch(url)
        .then(res => res.ok ? res.text() : null)
        .then(text => {
          if (text) {
            cachedTexts[name] = text;
            localStorage.setItem(cacheKey, text);
            localStorage.setItem(timeKey, now.toString());
            if (serverProfileIds[name]) delete serverProfileIds[name];
            console.log(`[Endurance Extension] Background cache updated for: ${name}`);
          }
        })
        .catch(e => console.error(`[Endurance Extension] Background fetch failed for ${name}:`, e));
    }
  });

  // Safe handler that uploads raw text to the backend and returns a session profile ID
  async function handleRoutingUrl(urlStr) {
    try {
      const urlObj = new URL(urlStr, window.location.origin);
      const params = new URLSearchParams(urlObj.search);
      const currentProfile = params.get('profile');

      if (currentProfile && ENDURANCE_PROFILES[currentProfile]) {
        if (serverProfileIds[currentProfile]) {
          params.set('profile', serverProfileIds[currentProfile]);
          urlObj.search = params.toString();
          return urlObj.toString();
        }

        const rawScriptText = cachedTexts[currentProfile];
        if (rawScriptText) {
          const baseEngineUrl = urlObj.origin + urlObj.pathname;
          const profileUploadUrl = baseEngineUrl + "/profile";

          console.log(`[Endurance Extension] Uploading script to absolute target: ${profileUploadUrl}`);

          const uploadResponse = await nativeFetch(profileUploadUrl, {
            method: "POST",
            headers: { "Content-Type": "text/plain;charset=UTF-8" },
            body: rawScriptText
          });

          if (uploadResponse.ok) {
            const resData = await uploadResponse.json();
            if (resData && resData.profileid) {
              console.log(`[Endurance Extension] Successfully generated server ID: ${resData.profileid}`);
              serverProfileIds[currentProfile] = resData.profileid;
              params.set('profile', resData.profileid);
              urlObj.search = params.toString();
              return urlObj.toString();
            }
          }
        }
      }
    } catch (e) {
      console.error("[Endurance Extension] Error in URL modifier:", e);
    }
    return urlStr;
  }

  // ==========================================
  // PART 1: XMLHttpRequest Interceptor (For legacy UI)
  // ==========================================
  const originalXHR = window.XMLHttpRequest;
  function CustomXMLHttpRequest() {
    const xhr = new originalXHR();
    const originalOpen = xhr.open;
    const originalSend = xhr.send;
    let currentUrl = "";

    xhr.open = function(method, url, ...rest) {
      currentUrl = url;
      return originalOpen.apply(this, [method, url, ...rest]);
    };

    xhr.send = async function(body) {
      if (typeof currentUrl === 'string') {
        const lowerUrl = currentUrl.toLowerCase();

        // Early exit strategy to minimize extension interference footprint
        const isLocalRequest = !currentUrl.startsWith('http://') && !currentUrl.startsWith('https://');
        const isRoutingDomain = lowerUrl.includes(window.location.hostname);
        if (!isLocalRequest && !isRoutingDomain) {
          return originalSend.apply(this, arguments);
        }

        // Intercept profile file requests to prevent local 404 errors
        for (const name of Object.keys(ENDURANCE_PROFILES)) {
          if (lowerUrl.includes(`${name.toLowerCase()}.brf`)) {
            Object.defineProperty(this, 'status', { writable: true, value: 200 });
            Object.defineProperty(this, 'statusText', { writable: true, value: 'OK' });
            Object.defineProperty(this, 'readyState', { writable: true, value: 4 });
            Object.defineProperty(this, 'responseText', { writable: true, value: cachedTexts[name] || "" });
            Object.defineProperty(this, 'response', { writable: true, value: cachedTexts[name] || "" });

            if (this.onreadystatechange) this.onreadystatechange();
            if (this.onload) this.onload();
            return;
          }
        }

        // Intercept routing engine execution calls
        if (lowerUrl.includes('/brouter') && lowerUrl.includes('lonlats=')) {
          const modifiedUrl = await handleRoutingUrl(currentUrl);
          if (modifiedUrl !== currentUrl) {
            originalOpen.apply(this, ['GET', modifiedUrl, true]);
          }
        }
      }
      return originalSend.apply(this, arguments);
    };

    return xhr;
  }
  window.XMLHttpRequest = CustomXMLHttpRequest;

  // ==========================================
  // PART 2: Fetch Interceptor (For modern Svelte UI)
  // ==========================================
  window.fetch = async function(input, init) {
    let url = "";
    if (typeof input === 'string') {
      url = input;
    } else if (input && typeof input === 'object' && input.url) {
      url = input.url;
    }

    if (url) {
      const lowerUrl = url.toLowerCase();

      // Early exit strategy to minimize extension interference footprint
      const isLocalRequest = !url.startsWith('http://') && !url.startsWith('https://');
      const isRoutingDomain = lowerUrl.includes(window.location.hostname);
      if (!isLocalRequest && !isRoutingDomain) {
        return nativeFetch.apply(this, [input, init]);
      }

      // Intercept profile file requests to prevent local 404 errors
      for (const name of Object.keys(ENDURANCE_PROFILES)) {
        if (lowerUrl.includes(`${name.toLowerCase()}.brf`)) {
          const text = cachedTexts[name] || "";
          return new Response(text, {
            status: 200,
            statusText: "OK",
            headers: { 'Content-Type': 'text/plain; charset=UTF-8' }
          });
        }
      }

      // Intercept routing engine execution calls
      if (lowerUrl.includes('/brouter') && lowerUrl.includes('lonlats=')) {
        const modifiedUrl = await handleRoutingUrl(url);
        if (typeof input === 'string') {
          input = modifiedUrl;
        } else if (input && typeof input === 'object' && input.url) {
          input = new Request(modifiedUrl, input);
        }
      }
    }

    return nativeFetch.apply(this, [input, init]);
  };

  // ==========================================
  // PART 3: Universal DOM Options Injector & Sorter
  // ==========================================
  function syncDomUniversal() {
    // Strict domain-based selection to prevent interfering with uninitialized elements
    const isBrouterDe = window.location.hostname.includes('brouter.de');
    const selectSelector = isBrouterDe ? 'select#profile-alternative' : 'select[id*="profile"], select';

    const select = document.querySelector(selectSelector);
    if (!select) return;

    // PROTECTION GUARD FOR LEGACY BOOTSTRAP-SELECT (brouter.de):
    // If the plugin has not yet initialized the select, skip this frame to prevent layout/state corruption.
    if (isBrouterDe && !select.closest('.bootstrap-select')) {
      return;
    }

    // Ultra-light optimization guard: prevent unnecessary tree traversals if already initialized
    if (select.querySelector('option[value="Endurance"]')) return;

    let targetContainer = select.querySelector('optgroup#profile, optgroup[label*="Profile"]');
    if (!targetContainer) {
      targetContainer = select;
    }

    // Sorting guard: wait until the app populates default profiles to avoid wrong ordering
    const hasDefaultProfiles = select.textContent.includes('Trekking') || select.textContent.includes('Fastbike');
    if (!hasDefaultProfiles) return;

    // Determine the anchor element for relative sorting
    let anchorOption = null;
    if (!isBrouterDe) {
      const starOptions = Array.from(targetContainer.querySelectorAll('option')).filter(opt =>
        opt.textContent.includes('⭐️') || opt.textContent.includes('⭐')
      );
      if (starOptions.length > 0) {
        anchorOption = starOptions[starOptions.length - 1].nextElementSibling;
      }
    } else {
      anchorOption = targetContainer.querySelector('option[value="car-eco"]');
    }

    let wasAdded = false;

    Object.keys(ENDURANCE_PROFILES).forEach(name => {
      if (!select.querySelector(`option[value="${name}"]`)) {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = `🚴 ${name}`;

        if (anchorOption) {
          targetContainer.insertBefore(option, anchorOption);
        } else {
          targetContainer.appendChild(option);
        }
        wasAdded = true;
      }
    });

    if (wasAdded) {
      // Safely notify UI plugins without breaking native single-select state loops
      if (isBrouterDe) {
        // Use native selectpicker refresh if jQuery layer is available in current world window
        try {
          if (window.$ && typeof window.$.fn.selectpicker === 'function') {
            window.$(select).selectpicker('refresh');
          } else {
            // Standard fallback events for legacy plugin detection
            select.dispatchEvent(new Event('contentChanged', { bubbles: true }));
          }
        } catch(e) {}
      } else {
        // Svelte / Modern UI event dispatchers
        select.dispatchEvent(new Event('contentChanged', { bubbles: true }));
        window.dispatchEvent(new Event('storage'));
      }
      console.log("[Endurance Extension] UI sorted and safely refreshed.");
    }
  }

  // ==========================================
  // PART 4: Initialization & Lifecycle Management
  // ==========================================

  // Efficient DOM lifecycle event tracking via modern MutationObserver
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.target && typeof m.target.querySelector === 'function') {
        if (m.target.querySelector('select#profile-alternative, select[id*="profile"], select')) {
          syncDomUniversal();
          break;
        }
      }
    }
  });

  // Observe DOM for profile select initialization
  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      observer.observe(document.body, { childList: true, subtree: true });
    });
  }

  // Fallback backup timer loop (Critical safeguard):
  // Ensures profiles inject even if Bootstrap-Select setup bypasses MutationObserver mutations.
  // Automatically self-destructs once injection is verified or after 30 seconds.
  let fallbackAttempts = 0;
  const fallbackTimer = setInterval(() => {
    syncDomUniversal();
    fallbackAttempts++;

    // Self-destruct condition: successfully injected or hit the safe limit (30 seconds)
    const isSuccess = document.querySelector('option[value="Endurance"]') !== null;
    if (isSuccess || fallbackAttempts > 120) {
      clearInterval(fallbackTimer);
      console.log("[Endurance Extension] Lifecyle setup complete. Fallback timer deactivated.");
    }
  }, 250);

  // Initial check just in case the document is already parsed before script execution
  if (document.readyState !== 'loading') {
    syncDomUniversal();
  } else {
    document.addEventListener('DOMContentLoaded', syncDomUniversal);
  }

})();
