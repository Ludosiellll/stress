interface BatteryManager {
  charging: boolean;
}

/** Battery API (Chromium and WebView2). null when it is missing or refuses. */
export async function batteryCharging(): Promise<boolean | null> {
  const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryManager> };
  if (typeof nav.getBattery !== 'function') return null;
  try {
    return (await nav.getBattery()).charging;
  } catch {
    return null;
  }
}
