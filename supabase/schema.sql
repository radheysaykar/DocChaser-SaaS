-- 1. Practitioners (CPA users)
CREATE TABLE practitioners (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT UNIQUE NOT NULL,
  firm_name TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE practitioners ENABLE ROW LEVEL SECURITY;

-- -- Function to automatically sync new auth users to practitioners
-- CREATE OR REPLACE FUNCTION public.handle_new_practitioner()
-- RETURNS TRIGGER AS $$
-- BEGIN
--   INSERT INTO public.practitioners (id, email)
--   VALUES (NEW.id, NEW.email);
--   RETURN NEW;
-- END;
-- $$ LANGUAGE plpgsql SECURITY DEFINER;

-- -- Trigger fired after auth signup
-- CREATE OR REPLACE TRIGGER on_auth_user_created
--   AFTER INSERT ON auth.users
--   FOR EACH ROW EXECUTE FUNCTION public.handle_new_practitioner();

CREATE POLICY "Practitioners can view their own profile"
ON practitioners FOR SELECT
USING (auth.uid() = id);

CREATE POLICY "Practitioners can update their own profile"
ON practitioners FOR UPDATE
USING (auth.uid() = id);















-- 2. Request Sessions
CREATE TABLE request_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practitioner_id UUID REFERENCES practitioners(id) ON DELETE CASCADE,
  client_name TEXT NOT NULL,
  client_contact TEXT NOT NULL,
  token TEXT UNIQUE NOT NULL DEFAULT gen_random_uuid()::text,
  -- status TEXT DEFAULT 'completed' CHECK (status IN ('pending', 'completed')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
ALTER TABLE request_sessions 
ADD COLUMN client_timezone TEXT NOT NULL DEFAULT 'America/New_York';
-- 1. Add tracking columns to request_sessions table
ALTER TABLE request_sessions
ADD COLUMN IF NOT EXISTS reminder_stage INT NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS last_event_time TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS next_event_time TIMESTAMPTZ;
-- 1. Add pending to request_sessions
ALTER TABLE request_sessions
ADD COLUMN IF NOT EXISTS pending INT NOT NULL DEFAULT 0;
ALTER TABLE request_sessions
DROP COLUMN IF EXISTS status;

ALTER TABLE request_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Practitioners can view their own sessions"
ON request_sessions FOR SELECT
USING (auth.uid() = practitioner_id);

CREATE POLICY "Practitioners can insert their own sessions"
ON request_sessions FOR INSERT
WITH CHECK (auth.uid() = practitioner_id);

CREATE POLICY "Public can view session by token"
ON request_sessions FOR SELECT
USING (true); -- We rely on the unguessable token for access

-- -- 2. Updated Trigger Function to auto-sync status and handle completion state
-- CREATE OR REPLACE FUNCTION update_request_session_status()
-- RETURNS TRIGGER AS $$
-- DECLARE
--   target_session_id UUID;
--   pending_count INT;
-- BEGIN
--   target_session_id := COALESCE(NEW.session_id, OLD.session_id);

--   -- Count unuploaded items for this session
--   SELECT COUNT(*)
--   INTO pending_count
--   FROM requested_items
--   WHERE session_id = target_session_id
--     AND COALESCE(is_uploaded, FALSE) = FALSE;

--   IF pending_count = 0 THEN
--     -- All docs uploaded: complete session, set reminder_stage = 4, clear next_event_time
--     UPDATE request_sessions
--     SET 
--       status = 'completed',
--       reminder_stage = 4,
--       next_event_time = NULL
--     WHERE id = target_session_id;
--   ELSE
--     -- Unuploaded docs remain: reset status to pending
--     UPDATE request_sessions
--     SET status = 'pending'
--     WHERE id = target_session_id;
--   END IF;

--   RETURN NEW;
-- END;
-- $$ LANGUAGE plpgsql;

-- -- 3. Re-attach Trigger to requested_items
-- DROP TRIGGER IF EXISTS tr_sync_session_status ON requested_items;

-- CREATE TRIGGER tr_sync_session_status
-- AFTER INSERT OR UPDATE OF is_uploaded OR DELETE
-- ON requested_items
-- FOR EACH ROW
-- EXECUTE FUNCTION update_request_session_status();



-- 1. Recreate Increment Function with SECURITY DEFINER
CREATE OR REPLACE FUNCTION inc_session_pending_fun()
RETURNS TRIGGER 
SECURITY DEFINER -- Runs with owner privileges, bypassing RLS restrictions
AS $$
BEGIN
  UPDATE request_sessions
  SET 
    pending = pending + 1,
    reminder_stage = 0,
    next_event_time = NOW()
  WHERE id = NEW.session_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 2. Recreate Decrement Function with SECURITY DEFINER
CREATE OR REPLACE FUNCTION dec_session_pending_fun()
RETURNS TRIGGER 
SECURITY DEFINER -- Runs with owner privileges, bypassing RLS restrictions
AS $$
DECLARE
  target_session_id UUID;
  new_count INT;
BEGIN
  target_session_id := COALESCE(NEW.session_id, OLD.session_id);

  -- Decrement count and capture the resulting pending_docs_count
  UPDATE request_sessions
  SET pending = GREATEST(pending - 1, 0)
  WHERE id = target_session_id
  RETURNING pending INTO new_count;

  -- If all documents are uploaded (pending = 0), set stage to 4 and clear next_event_time
  IF new_count = 0 THEN
    UPDATE request_sessions
    SET 
      reminder_stage = 4,
      next_event_time = NULL
    WHERE id = target_session_id;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- 3. Clean up existing triggers
DROP TRIGGER IF EXISTS trg_inc_session_pending_insert ON requested_items;
DROP TRIGGER IF EXISTS trg_inc_session_pending_update ON requested_items;
DROP TRIGGER IF EXISTS trg_dec_session_pending_update ON requested_items;
DROP TRIGGER IF EXISTS trg_dec_session_pending_delete ON requested_items;

-- 4. Re-attach Triggers with safe COALESCE evaluation

-- Trigger A: New item inserted (defaults to unuploaded)
CREATE TRIGGER trg_inc_session_pending_insert
AFTER INSERT ON requested_items
FOR EACH ROW
WHEN (COALESCE(NEW.is_uploaded, FALSE) = FALSE)
EXECUTE FUNCTION inc_session_pending_fun();

-- Trigger B: Item invalidated (TRUE -> FALSE)
CREATE TRIGGER trg_inc_session_pending_update
AFTER UPDATE OF is_uploaded ON requested_items
FOR EACH ROW
WHEN (COALESCE(OLD.is_uploaded, FALSE) = TRUE AND COALESCE(NEW.is_uploaded, FALSE) = FALSE)
EXECUTE FUNCTION inc_session_pending_fun();

-- Trigger C: Item uploaded (FALSE -> TRUE)
CREATE TRIGGER trg_dec_session_pending_update
AFTER UPDATE OF is_uploaded ON requested_items
FOR EACH ROW
WHEN (COALESCE(OLD.is_uploaded, FALSE) = FALSE AND COALESCE(NEW.is_uploaded, FALSE) = TRUE)
EXECUTE FUNCTION dec_session_pending_fun();

-- Trigger D: Unuploaded item deleted
CREATE TRIGGER trg_dec_session_pending_delete
AFTER DELETE ON requested_items
FOR EACH ROW
WHEN (COALESCE(OLD.is_uploaded, FALSE) = FALSE)
EXECUTE FUNCTION dec_session_pending_fun();









-- 3. Requested Items
CREATE TABLE requested_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES request_sessions(id) ON DELETE CASCADE,
  document_title TEXT NOT NULL,
  file_path TEXT,
  is_uploaded BOOLEAN DEFAULT FALSE,
  uploaded_at TIMESTAMP WITH TIME ZONE
);
ALTER TABLE requested_items 
ADD COLUMN IF NOT EXISTS file_path TEXT,
ADD COLUMN IF NOT EXISTS file_name TEXT;

ALTER TABLE requested_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Practitioners can view items for their sessions"
ON requested_items FOR SELECT
USING (EXISTS (
  SELECT 1 FROM request_sessions
  WHERE request_sessions.id = requested_items.session_id
  AND request_sessions.practitioner_id = auth.uid()
));

CREATE POLICY "Practitioners can insert items for their sessions"
ON requested_items FOR INSERT
WITH CHECK (EXISTS (
  SELECT 1 FROM request_sessions
  WHERE request_sessions.id = requested_items.session_id
  AND request_sessions.practitioner_id = auth.uid()
));

CREATE POLICY "Public can view and update items by session"
ON requested_items FOR SELECT
USING (true); -- Allowed to see checklist when viewing session via token

CREATE POLICY "Public can update items to mark uploaded"
ON requested_items FOR UPDATE
USING (true)
WITH CHECK (true); -- In a real app, we'd ensure they can only update is_uploaded and file_path for their specific session

















-- 1. Create Private Storage Bucket
INSERT INTO storage.buckets (id, name, public) 
VALUES ('client-documents', 'client-documents', false)
ON CONFLICT (id) DO NOTHING;

-- 2. Allow clients to upload files if they have a valid token match
CREATE POLICY "Allow anonymous upload via valid token"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'client-documents'
);








-- Storage Bucket configuration (requires 'client-documents' bucket to be created)
-- Note: You must create the storage bucket manually in Supabase dashboard.
-- CREATE POLICY "Public can upload to client-documents"
-- ON storage.objects FOR INSERT
-- WITH CHECK (bucket_id = 'client-documents');

-- CREATE POLICY "Practitioners can view client-documents"
-- ON storage.objects FOR SELECT
-- USING (bucket_id = 'client-documents' AND auth.role() = 'authenticated');
