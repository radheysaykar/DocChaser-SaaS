
import { revalidatePath } from 'next/cache';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import Link from 'next/link';






























// Initialize Supabase Server Client
async function getSupabaseClient() {
  const cookieStore = await cookies();

  const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/[^\x00-\x7F]/g, '').trim();
  const supabaseKey = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '').replace(/[^\x00-\x7F]/g, '').trim();
  
  return createServerClient(
    supabaseUrl,
    supabaseKey,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Server Components cannot write cookies directly
          }
        },
      },
    }
  );
}




















// Server Action: Handle Sign Up
async function signUp(formData: FormData) {
  'use server';

  const supabase = await getSupabaseClient();
  const firm_name = formData.get('firm_name') as string;
  const email = formData.get('email') as string;
  const password = formData.get('password') as string;
  
  // 1. Create user in Supabase Auth
  const { data, error: authError } = await supabase.auth.signUp({
    email,
    password,
  });

  if (authError) {
    throw new Error(authError.message);
  }

  // 2. Upsert practitioner profile (prevents duplicate key crashes if record/trigger already exists)
  if (data.user) {
    const { error: dbError } = await supabase
      .from('practitioners')
      .upsert(
        {
          id: data.user.id,
          email: email,
          firm_name: firm_name,
        },
        { onConflict: 'id' } // If ID exists, updates the row instead of crashing
      );

    if (dbError) {
      throw new Error(`Failed to save practitioner profile: ${dbError.message}`);
    }
  }

  revalidatePath('/');
}


























// Server Action: Handle Log In
async function login(formData: FormData) {
  'use server';

  const supabase = await getSupabaseClient();
  const email = formData.get('email') as string;
  const password = formData.get('password') as string;

  const { error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    throw new Error(error.message);
  }

  revalidatePath('/');
}























// Server Action: Handle Sign Out
async function signOut() {
  'use server';

  const supabase = await getSupabaseClient();
  await supabase.auth.signOut();
  revalidatePath('/');
}

/////////////////////////////////


























// Common timezones list
const COMMON_TIMEZONES = [
  'Asia/Kolkata',
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Paris',
  'Asia/Singapore',
  'Australia/Sydney',
];
























// Server Action: Create a new client request session
async function createClientSession(formData: FormData) {
  'use server';

  const supabase = await getSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) throw new Error('Unauthorized');

  const client_name = formData.get('client_name') as string;
  const client_contact = formData.get('client_contact') as string;
  const client_timezone = (formData.get('client_timezone') as string) || 'America/New_York';

  const { error } = await supabase.from('request_sessions').insert([
    {
      practitioner_id: user.id,
      client_name,
      client_contact,
      client_timezone,
    },
  ]);

  if (error) throw new Error(error.message);
  revalidatePath('/');
}






















// Data Fetcher: Get current practitioner profile, sessions, and documents
async function getPractitionerDashboardData(userId: string) {
  const supabase = await getSupabaseClient();

  // 1. Fetch practitioner info
  const { data: practitioner } = await supabase
    .from('practitioners')
    .select('*')
    .eq('id', userId)
    .single();

  // 2. Fetch sessions and nested requested items for this practitioner
  const { data: sessions } = await supabase
    .from('request_sessions')
    .select(`
      *,
      requested_items (*)
    `)
    .eq('practitioner_id', userId)
    .order('created_at', { ascending: false });

  return { practitioner, sessions };
}
























//////////////////////////////////


export default async function Page() {
  const supabase = await getSupabaseClient();

  // Get currently authenticated user session
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Inside Page() after getting user:
const { practitioner, sessions } = user
? await getPractitionerDashboardData(user.id)
: { practitioner: null, sessions: [] };


















  return (
    <main className="max-w-md mx-auto p-6 space-y-8">
      {user ? 
(
<div className="space-y-8">
  {/* Header & Logout */}
  <div className="flex justify-between items-center bg-white border border-gray-200 rounded-xl p-6 shadow-sm">
    <div>
      <h1 className="text-2xl font-bold text-gray-900">
        Welcome, {practitioner?.firm_name || user.email}
      </h1>
      <p className="text-xs font-mono text-gray-500 mt-1">ID: {user.id}</p>
    </div>
    <form action={signOut}>
      <button
        type="submit"
        className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded-lg transition-colors"
      >
        Log Out
      </button>
    </form>
  </div>

  {/* Form: Add New Client Request Session */}
  <section className="bg-white border border-gray-200 rounded-xl p-6 shadow-sm">
    <h2 className="text-lg font-semibold text-gray-800 mb-4">Create Client Request</h2>
    <form action={createClientSession} className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      <input
        type="text"
        name="client_name"
        placeholder="Client Name"
        required
        className="px-3 py-2 border border-gray-300 text-black rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      <input
        type="text"
        name="client_contact"
        placeholder="Client Contact (Email/Phone)"
        required
        className="px-3 py-2 border border-gray-300 text-black rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      <select
              name="client_timezone"
              defaultValue="America/New_York"
              className="w-full px-3 py-2 border border-gray-300 text-black rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
            >
              {COMMON_TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
      </select>
      <button
        type="submit"
        className="bg-blue-600 hover:bg-blue-700 text-white font-medium text-sm rounded-lg px-4 py-2 transition-colors"
      >
        Add Client
      </button>
    </form>
  </section>

  {/* Client Sessions Table */}
  <section className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
    <div className="p-6 border-b border-gray-200">
      <h2 className="text-lg font-semibold text-gray-800">Your Clients</h2>
    </div>
    <div className="overflow-x-auto">
      <table className="w-full text-left border-collapse">
        <thead>
          <tr className="bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase">
            <th className="px-6 py-3">Client</th>
            <th className="px-6 py-3">Contact</th>
            <th className="px-6 py-3">Pending</th>
            <th className="px-6 py-3">Timezone</th>
            <th className="px-6 py-3">Magic Token</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200 text-sm">
  {sessions && sessions.length > 0 ? (
    sessions.map((session) => (
      <tr 
        key={session.id} 
        className="hover:bg-blue-50/50 cursor-pointer transition-colors"
      >
        <td className="px-6 py-4 font-medium text-gray-900">
          <Link href={`/${session.token}`} className="block w-full h-full text-blue-600 hover:underline">
            {session.client_name}
          </Link>
        </td>
        <td className="px-6 py-4 text-gray-600">{session.client_contact}</td>
        <td className="px-6 py-4">
          <span
            className={`px-2 py-1 rounded-full text-xs font-medium ${
              session.pending == 0
                ? 'bg-green-100 text-green-800'
                : 'bg-yellow-100 text-yellow-800'
            }`}
          >
            {session.pending}
          </span>                      
        </td>
        <td className="px-6 py-4">
          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-800">
            {session.client_timezone || 'America/New_York'}
          </span>
        </td>
        <td className="px-6 py-4 font-mono text-xs text-gray-500">
          <Link href={`/${session.token}`} className="text-blue-600 hover:underline">
            {session.token}
          </Link>
        </td>
      </tr>
    ))
  ) : (
    <tr>
      <td colSpan={4} className="px-6 py-8 text-center text-gray-500">
        No client sessions found.
      </td>
    </tr>
  )}
</tbody>
      </table>
    </div>
  </section>

</div>
)































       : (
        /* Unauthenticated State: Auth Forms */
        <div className="space-y-6">
          {/* Log In Form */}
          <section className="bg-white border border-gray-200 rounded-xl p-6 shadow-sm space-y-4">
            <h2 className="text-xl font-semibold text-gray-800">Log In</h2>
            <form action={login} className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Email
                </label>
                <input
                  type="email"
                  name="email"
                  required
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Password
                </label>
                <a href="/forgot-password" style={{ fontSize: '0.85rem', color: '#0066cc', textDecoration: 'none' }}>
                  Forgot Password?
                </a>
                <input
                  type="password"
                  name="password"
                  required
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <button
                type="submit"
                className="w-full py-2 px-4 bg-blue-600 hover:bg-blue-700 text-white font-medium text-sm rounded-lg transition-colors"
              >
                Log In
              </button>
            </form>
          </section>

          {/* Sign Up Form */}
          <section className="bg-white border border-gray-200 rounded-xl p-6 shadow-sm space-y-4">
            <h2 className="text-xl font-semibold text-gray-800">Sign Up</h2>
            <form action={signUp} className="space-y-3">
            <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Firm
                </label>
                <input
                  type="firm_name"
                  name="firm_name"
                  required
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Email
                </label>
                <input
                  type="email"
                  name="email"
                  required
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Password
                </label>
                <input
                  type="password"
                  name="password"
                  required
                  minLength={6}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <button
                type="submit"
                className="w-full py-2 px-4 bg-gray-900 hover:bg-gray-800 text-white font-medium text-sm rounded-lg transition-colors"
              >
                Create Account
              </button>
            </form>
          </section>
        </div>
      )}
    </main>
  );
}
