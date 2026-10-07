/**
 * supabase-client.js - Supabase Client Inicializace pro LuminaReader.
 * Poskytuje připojení k Supabase REST API a Storage pro zálohování a synchronizaci.
 */

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

// Konfigurace Supabase projektu
export const SUPABASE_CONFIG = {
  rawUrl: "https://zqcrdjphnffhrpdmkjiy.supabase.co/rest/v1/",
  url: "https://zqcrdjphnffhrpdmkjiy.supabase.co",
  anonKey: "sb_publishable_uOBN7hcCpGPs0a-jx3bMhg_5CvJ3hmy",
  storageBucket: "book-files"
};

// Normalizace URL pro správné fungování createClient (odstranění /rest/v1/ přípony)
export const SUPABASE_URL = SUPABASE_CONFIG.url;
export const SUPABASE_REST_URL = SUPABASE_CONFIG.rawUrl;
export const SUPABASE_ANON_KEY = SUPABASE_CONFIG.anonKey;
export const STORAGE_BUCKET = SUPABASE_CONFIG.storageBucket;

/**
 * Inicializace klienta Supabase
 */
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});

/**
 * Rychlá kontrola stavu připojení k Supabase
 * @returns {Promise<boolean>}
 */
export async function checkSupabaseConnection() {
  if (!navigator.onLine) return false;
  try {
    const { error } = await supabase.from('books').select('id', { count: 'exact', head: true });
    return !error;
  } catch (e) {
    return false;
  }
}
