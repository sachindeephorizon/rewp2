/**
 * Reverse geocode via Nominatim.
 * Returns "Area, City" (e.g. "Paltan Bazar, Guwahati").
 * Non-critical — returns null on failure so it never blocks session save.
 */
async function reverseGeocode(lat, lng) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=16&addressdetails=1`;
    const res = await fetch(url, {
      headers: { "Accept-Language": "en", "User-Agent": "DeepHorizon/1.0" },
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json();
    if (!data.address) return null;

    const a = data.address;
    const area =
      a.road ||
      a.neighbourhood ||
      a.suburb ||
      a.city_district ||
      a.hamlet ||
      a.village ||
      null;
    const city =
      a.city ||
      a.town ||
      a.state_district ||
      a.county ||
      a.state ||
      null;

    if (area && city) return `${area}, ${city}`;
    if (area) return area;
    if (city) return city;

    // Fallback: first two parts of display_name
    if (data.display_name) {
      return data.display_name.split(",").slice(0, 2).join(",").trim();
    }
    return null;
  } catch (err) {
    console.error("[Geocode] Failed:", err.message);
    return null;
  }
}

module.exports = { reverseGeocode };
