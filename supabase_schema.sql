-- ==============================================================================
-- LuminaReader - Supabase Schema pro Synchronizaci Čtecích Statistik a Relací
-- ==============================================================================

-- 1. Tabulka pro detailní čtecí relace (reading_sessions)
-- Uchovává jednotlivé relace s aktivní dobou čtení >= 5 minut (300 sekund)
CREATE TABLE IF NOT EXISTS public.reading_sessions (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    start_time TIMESTAMPTZ NOT NULL,
    duration INTEGER NOT NULL DEFAULT 0,
    words_read INTEGER NOT NULL DEFAULT 0,
    avg_wpm INTEGER NOT NULL DEFAULT 220,
    peak_wpm INTEGER NOT NULL DEFAULT 220,
    intra_session_samples JSONB DEFAULT '[]'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- Indexy pro efektivní vyhledávání a řazení
CREATE INDEX IF NOT EXISTS idx_reading_sessions_book_id ON public.reading_sessions (book_id);
CREATE INDEX IF NOT EXISTS idx_reading_sessions_start_time ON public.reading_sessions (start_time DESC);
CREATE INDEX IF NOT EXISTS idx_reading_sessions_updated_at ON public.reading_sessions (updated_at DESC);

-- 2. Tabulka pro agregovaný souhrn čtecích statistik (reading_stats_summary)
-- Uchovává kumulativní statistiky a denní časy čtení pro synchronizaci mezi zařízeními
CREATE TABLE IF NOT EXISTS public.reading_stats_summary (
    id TEXT PRIMARY KEY DEFAULT 'global',
    total_words_read INTEGER NOT NULL DEFAULT 0,
    total_reading_seconds INTEGER NOT NULL DEFAULT 0,
    global_avg_wpm INTEGER NOT NULL DEFAULT 220,
    streak_days INTEGER NOT NULL DEFAULT 0,
    last_read_date DATE DEFAULT CURRENT_DATE,
    daily_minutes_map JSONB DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- 3. Row Level Security (RLS) a politiky pro anonymní i přihlášené klienty
ALTER TABLE public.reading_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reading_stats_summary ENABLE ROW LEVEL SECURITY;

-- Politika pro reading_sessions
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies 
        WHERE tablename = 'reading_sessions' AND policyname = 'Allow public access on reading_sessions'
    ) THEN
        CREATE POLICY "Allow public access on reading_sessions" 
        ON public.reading_sessions FOR ALL 
        TO anon, authenticated 
        USING (true) WITH CHECK (true);
    END IF;
END $$;

-- Politika pro reading_stats_summary
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies 
        WHERE tablename = 'reading_stats_summary' AND policyname = 'Allow public access on reading_stats_summary'
    ) THEN
        CREATE POLICY "Allow public access on reading_stats_summary" 
        ON public.reading_stats_summary FOR ALL 
        TO anon, authenticated 
        USING (true) WITH CHECK (true);
    END IF;
END $$;
