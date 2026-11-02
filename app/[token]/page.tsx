import { notFound } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import Link from 'next/link';

async function getSupabaseClient() {
  const cookieStore = await cookies();
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing Supabase Environment Variables');
  }

  return createServerClient(supabaseUrl, supabaseKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        } catch {}
      },
    },
  });
}

// Allowed MIME types and max size (10MB)
const ALLOWED_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/jpg'];
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

// Helper function to sanitize text for URL-safe filenames
function sanitizeFileName(str: string): string {
  return str
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_') // Replace spaces & special chars with underscores
    .replace(/_+/g, '_');             // Collapse multiple consecutive underscores
}

async function uploadClientDocument(formData: FormData) {
  'use server';

  const supabase = await getSupabaseClient();
  const itemId = formData.get('item_id') as string;
  const token = formData.get('token') as string;
  const clientName = (formData.get('client_name') as string) || 'Client';
  const docTitle = (formData.get('doc_title') as string) || 'Document';
  const file = formData.get('document_file') as File;

  if (!file || file.size === 0) {
    throw new Error('No valid file provided.');
  }

  // Extract file extension and base name
  const lastDotIndex = file.name.lastIndexOf('.');
  const rawBaseName = lastDotIndex !== -1 ? file.name.substring(0, lastDotIndex) : file.name;
  const ext = lastDotIndex !== -1 ? file.name.substring(lastDotIndex + 1) : '';

  // Format timestamp YYYYMMDD_HHMMSS
  const now = new Date();
  const timestamp = now.toISOString().replace(/[-:]/g, '').replace('T', '_').split('.')[0];

  // Sanitize components
  const cleanClient = sanitizeFileName(clientName);
  const cleanTitle = sanitizeFileName(docTitle);
  const cleanOriginal = sanitizeFileName(rawBaseName);

  // Format: [ClientName]_[DocTitle]_[YYYYMMDD_HHMMSS]_[OriginalFileName].[ext]
  const structuredFileName = ext 
    ? `${cleanClient}_${cleanTitle}_${timestamp}_${cleanOriginal}.${ext}`
    : `${cleanClient}_${cleanTitle}_${timestamp}_${cleanOriginal}`;

  // Bucket path key
  const filePath = `${token}/${structuredFileName}`;

  // Upload to Supabase bucket
  const { error: uploadError } = await supabase.storage
    .from('client-documents')
    .upload(filePath, file, {
      contentType: file.type,
      upsert: true,
    });

  if (uploadError) {
    throw new Error(`Failed to upload file to storage: ${uploadError.message}`);
  }

  // Update requested item state in Postgres DB
  const { error: dbError } = await supabase
    .from('requested_items')
    .update({
      is_uploaded: true,
      uploaded_at: new Date().toISOString(),
      file_path: filePath,
      file_name: structuredFileName,
    })
    .eq('id', itemId);

  if (dbError) {
    throw new Error(`Failed to update database record: ${dbError.message}`);
  }
  // Note: PostgreSQL trigger automatically updates request_sessions.status to 'completed' or 'pending'
  revalidatePath(`/${token}`);
}

// Server Action: Add document requirement (Practitioner Only)
async function addRequestedItem(formData: FormData) {
  'use server';

  const supabase = await getSupabaseClient();
  const sessionId = formData.get('session_id') as string;
  const token = formData.get('token') as string;
  const documentTitle = formData.get('document_title') as string;

  if (!sessionId || !documentTitle || documentTitle.trim() === '') return;

  const { error } = await supabase.from('requested_items').insert([
    {
      session_id: sessionId,
      document_title: documentTitle.trim(),
    },
  ]);

  if (error) {
    console.error('Error adding document item:', error.message);
    throw new Error(error.message);
  }

  revalidatePath(`/${token}`);
}


// 2. New Practitioner Toggle Action
async function toggleDocumentStatus(formData: FormData) {
  'use server';
  
  const supabase = await getSupabaseClient();
  const itemId = formData.get('item_id') as string;
  const token = formData.get('token') as string;
  const currentStatus = formData.get('current_status') === 'true';  await supabase
    .from('requested_items')
    .update({ is_uploaded: !currentStatus })
    .eq('id', itemId);  revalidatePath(`/${token}`);
}

export default async function ClientSessionPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const supabase = await getSupabaseClient();

  // Fetch Auth User & Session concurrently to keep response times fast
  const [authResult, sessionResult] = await Promise.all([
    supabase.auth.getUser(),
    supabase
      .from('request_sessions')
      .select(`
        *,
        practitioners (firm_name, email),
        requested_items (*)
      `)
      .eq('token', token)
      .maybeSingle(),
  ]);

  const user = authResult.data.user;
  const session = sessionResult.data;

  if (sessionResult.error || !session) {
    notFound();
  }

  // Verify Practitioner Ownership
  const isOwner = user ? user.id === session.practitioner_id : false;

  // Generate signed URLs for uploaded files (Only if practitioner)
  const itemsWithUrls = await Promise.all(
    (session.requested_items || []).map(async (doc: any) => {
      let downloadUrl = null;

      if (isOwner && doc.is_uploaded && doc.file_path) {
        const { data } = await supabase.storage
          .from('client-documents')
          .createSignedUrl(doc.file_path, 3600); // URL valid for 60 mins

        downloadUrl = data?.signedUrl || null;
      }

      return { ...doc, downloadUrl };
    })
  );

  return (
    <main className="max-w-5xl mx-auto p-6 space-y-8">
      {/* Header */}
      <div className="space-y-4">
        {isOwner && (
          <Link
            href="/"
            className="inline-flex items-center text-sm text-grey hover:underline font-medium"
          >
            &larr; Back to Practitioner Dashboard
          </Link>
        )}

        <div className="bg-white border border-gray-200 rounded-xl p-6 shadow-sm flex justify-between items-start">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">
              Document Portal: {session.client_name}
            </h1>
            <p className="text-sm text-gray-600 mt-1">
              Contact: <span className="font-medium">{session.client_contact}</span>
            </p>
          </div>
          <span
            className={`px-3 py-1 rounded-full text-xs font-semibold ${
              session.status === 'completed'
                ? 'bg-green-100 text-green-800'
                : 'bg-yellow-100 text-yellow-800'
            }`}
          >
            {session.status}
          </span>
        </div>
      </div>

      {/* Practitioner Panel: Add Document Request */}
      {isOwner && (
        <section className="bg-blue-50/60 border border-blue-200 text-black rounded-xl p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-blue-900 mb-1">
            Add Requested Document
          </h2>
          <form action={addRequestedItem} className="flex gap-3 mt-3">
            <input type="hidden" name="session_id" value={session.id} />
            <input type="hidden" name="token" value={session.token} />
            <input
              type="text"
              name="document_title"
              placeholder="e.g. Form 16, Bank Statement, PAN Card"
              required
              className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
            />
            <button
              type="submit"
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium text-sm rounded-lg shadow-sm"
            >
              Add Requirement
            </button>
          </form>
        </section>
      )}

      {/* Documents Table */}
      <section className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
        <div className="p-6 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-800">
            Required Documents
          </h2>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase">
                <th className="px-6 py-3">Document Title</th>
                <th className="px-6 py-3">Status</th>
                <th className="px-6 py-3">Action / Upload</th>
                {isOwner && <th className="px-6 py-3">Practitioner View</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 text-sm">
              {itemsWithUrls.length > 0 ? (
                itemsWithUrls.map((doc: any) => (
                  <tr key={doc.id} className="hover:bg-gray-50/50">
                    <td className="px-6 py-4 font-medium text-gray-900">
                      {doc.document_title}
                    </td>

                    {/* UI Toggle Component inside Practitioners View Column: */}
                    {isOwner && (
                      <td className="px-6 py-4 flex items-center gap-3">
                        {doc.downloadUrl ? (
                          <a href={doc.downloadUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:underline">
                            View
                          </a>
                        ) : null}
                        
                        <form action={toggleDocumentStatus}>
                          <input type="hidden" name="item_id" value={doc.id} />
                          <input type="hidden" name="token" value={token} />
                          <input type="hidden" name="current_status" value={String(doc.is_uploaded)} />
                          <button 
                            type="submit" 
                            className={`px-2 py-1 text-xs rounded font-medium ${
                              doc.is_uploaded ? 'bg-amber-100 text-amber-800 hover:bg-amber-200' : 'bg-emerald-100 text-emerald-800 hover:bg-emerald-200'
                            }`}
                          >
                            {doc.is_uploaded ? 'Mark Pending' : 'Mark Completed'}
                          </button>
                        </form>
                      </td>
                    )}

                    {/* Action Column: Show upload form to client if pending */}
                    <td className="px-6 py-4">
                      {!doc.is_uploaded ? (
                        <form action={uploadClientDocument} className="flex items-center gap-2">
                          <input type="hidden" name="item_id" value={doc.id} />
                          <input type="hidden" name="token" value={token} />
                          <input type="hidden" name="client_name" value={session.client_name} />
                          <input type="hidden" name="doc_title" value={doc.document_title} />
                          <input
                            type="file"
                            name="document_file"
                            accept=".pdf,.jpg,.jpeg,.png"
                            required
                            className="text-xs text-gray-600 file:mr-2 file:py-1 file:px-2.5 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
                          />
                          <button
                            type="submit"
                            className="px-3 py-1 bg-green-600 hover:bg-green-700 text-white text-xs font-medium rounded shadow-sm"
                          >
                            Upload
                          </button>
                        </form>
                      ) : (
                        <span className="text-xs text-gray-500 italic">
                          Submitted ({doc.file_name || 'File attached'})
                        </span>
                      )}
                    </td>

                    {/* Practitioner Column: Only visible to logged-in practitioner owner */}
                    {isOwner && (
                      <td className="px-6 py-4">
                        {doc.downloadUrl ? (
                          <a
                            href={doc.downloadUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center text-xs text-blue-600 hover:underline font-semibold"
                          >
                            View Document &rarr;
                          </a>
                        ) : (
                          <span className="text-xs text-gray-400">—</span>
                        )}
                      </td>
                    )}
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={isOwner ? 4 : 3} className="px-6 py-8 text-center text-gray-500">
                    No documents requested yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

