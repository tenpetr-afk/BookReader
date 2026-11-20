-- ==============================================================================
-- LuminaReader - Supabase Schema pro Synchronizaci Knih, Pozice a Statistik
-- ==============================================================================

-- 0. Tabulka pro knihy a synchronizaci přesné čtecí pozice (books)
CREATE TABLE IF NOT EXISTS public.books (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT 'Bez názvu',
    author TEXT DEFAULT NULL,
    file_name TEXT,
    file_type TEXT NOT NULL DEFAULT 'epub' CHECK (file_type IN ('epub', 'pdf')),
    file_path TEXT,
    file_size BIGINT DEFAULT NULL,
    file_hash TEXT DEFAULT NULL,
    cover_path TEXT DEFAULT NULL,
    cover_hash TEXT DEFAULT NULL,
    total_pages INTEGER DEFAULT NULL,
    total_chapters INTEGER DEFAULT NULL,
    total_words INTEGER DEFAULT NULL,
    current_chapter INTEGER NOT NULL DEFAULT 0,
    current_page INTEGER NOT NULL DEFAULT 1,
    scroll_progress DOUBLE PRECISION NOT NULL DEFAULT 0,
    pdf_ruler_height INTEGER NOT NULL DEFAULT 32,
    reading_anchor JSONB DEFAULT NULL,
    bookmarks JSONB DEFAULT '[]'::jsonb,
    progress_updated_at TIMESTAMPTZ DEFAULT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- Migrace pro stávající databáze: přidání sloupců pro obsahovou kotvu EPUB, záložky, metadata a obálky
ALTER TABLE public.books ADD COLUMN IF NOT EXISTS reading_anchor JSONB DEFAULT NULL;
ALTER TABLE public.books ADD COLUMN IF NOT EXISTS bookmarks JSONB DEFAULT '[]'::jsonb;
ALTER TABLE public.books ADD COLUMN IF NOT EXISTS progress_updated_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE public.books ADD COLUMN IF NOT EXISTS author TEXT DEFAULT NULL;
ALTER TABLE public.books ADD COLUMN IF NOT EXISTS file_size BIGINT DEFAULT NULL;
ALTER TABLE public.books ADD COLUMN IF NOT EXISTS file_hash TEXT DEFAULT NULL;
ALTER TABLE public.books ADD COLUMN IF NOT EXISTS cover_path TEXT DEFAULT NULL;
ALTER TABLE public.books ADD COLUMN IF NOT EXISTS cover_hash TEXT DEFAULT NULL;
ALTER TABLE public.books ADD COLUMN IF NOT EXISTS total_pages INTEGER DEFAULT NULL;
ALTER TABLE public.books ADD COLUMN IF NOT EXISTS total_chapters INTEGER DEFAULT NULL;
ALTER TABLE public.books ADD COLUMN IF NOT EXISTS total_words INTEGER DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_books_updated_at ON public.books (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_books_progress_updated_at ON public.books (progress_updated_at DESC);

ALTER TABLE public.books ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'books' AND policyname = 'Allow public access on books'
    ) THEN
        CREATE POLICY "Allow public access on books"
        ON public.books FOR ALL
        TO anon, authenticated
        USING (true) WITH CHECK (true);
    END IF;
END $$;

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
    is_deleted BOOLEAN DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- Migrace pro stávající databáze: přidání sloupce is_deleted pro soft delete
ALTER TABLE public.reading_sessions ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE;

-- Indexy pro efektivní vyhledávání a řazení
CREATE INDEX IF NOT EXISTS idx_reading_sessions_book_id ON public.reading_sessions (book_id);
CREATE INDEX IF NOT EXISTS idx_reading_sessions_start_time ON public.reading_sessions (start_time DESC);
CREATE INDEX IF NOT EXISTS idx_reading_sessions_updated_at ON public.reading_sessions (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_reading_sessions_is_deleted_book_id ON public.reading_sessions (is_deleted, book_id);

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
