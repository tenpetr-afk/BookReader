/**
 * supabase-client.js - Supabase Client Inicializace pro LuminaReader.
 * Poskytuje připojení k Supabase REST API a Storage pro zálohování a synchronizaci.
 */

// Konfigurace Supabase projektu
export const SUPABASE_CONFIG = {
  rawUrl: "https://zqcrdjphnffhrpdmkjiy.supabase.co/rest/v1/",
  url: "https://zqcrdjphnffhrpdmkjiy.supabase.co",
  anonKey: "sb_publishable_uOBN7hcCpGPs0a-jx3bMhg_5CvJ3hmy",
  storageBucket: "book-files"
};

// Normalizace URL pro správné fungování createClient (odstranění /rest/v1/ přípony)
export const SUPABASE_URL = SUPABASE_CONFIG.url || "";
export const SUPABASE_REST_URL = SUPABASE_CONFIG.rawUrl || "";
export const SUPABASE_ANON_KEY = SUPABASE_CONFIG.anonKey || "";
export const STORAGE_BUCKET = SUPABASE_CONFIG.storageBucket || "book-files";

/**
 * Získání createClient funkce s bezpečným fallbackem:
 * 1. window.supabase.createClient (z globálního script tagu v index.html)
 * 2. Dynamický import z CDN s ošetřením výjimky (offline / síťový výpadek)
 */
let createClientFn = null;
if (typeof window !== "undefined" && window.supabase && typeof window.supabase.createClient === "function") {
  createClientFn = window.supabase.createClient;
}

if (!createClientFn && typeof window !== "undefined") {
  try {
    const mod = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
    if (mod && typeof mod.createClient === "function") {
      createClientFn = mod.createClient;
    }
  } catch (err) {
    console.warn("[SupabaseClient] Supabase knihovnu se nepodařilo načíst ze sítě (offline režim):", err);
  }
}

/**
 * Inicializace klienta Supabase s kontrolou platnosti přihlašovacích údajů a ošetřením chyb
 */
function initSupabaseClient() {
  const hasCredentials = Boolean(
    SUPABASE_URL &&
    typeof SUPABASE_URL === "string" &&
    SUPABASE_URL.trim() !== "" &&
    SUPABASE_ANON_KEY &&
    typeof SUPABASE_ANON_KEY === "string" &&
    SUPABASE_ANON_KEY.trim() !== ""
  );

  if (!hasCredentials) {
    console.warn("[SupabaseClient] Supabase credentials (URL / anonKey) nebyly zadány. Aplikace funguje v plně lokálním režimu.");
    return null;
  }

  if (!createClientFn) {
    console.warn("[SupabaseClient] Funkce createClient není k dispozici (offline režim). Aplikace funguje v plně lokálním režimu.");
    return null;
  }

  try {
    return createClientFn(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    });
  } catch (err) {
    console.warn("[SupabaseClient] Výjimka při vytváření instance Supabase klienta:", err);
    return null;
  }
}

export const supabase = initSupabaseClient();

/**
 * Rychlá kontrola stavu připojení k Supabase
 * @returns {Promise<boolean>}
 */
export async function checkSupabaseConnection() {
  if (!supabase || (typeof navigator !== "undefined" && !navigator.onLine)) {
    return false;
  }
  try {
    const { error } = await supabase.from('books').select('id', { count: 'exact', head: true });
    return !error;
  } catch (e) {
    return false;
  }
}
