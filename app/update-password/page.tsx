'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@supabase/supabase-js';
import { useRouter } from 'next/navigation';

const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/[^\x00-\x7F]/g, '').trim();
const supabaseKey = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '').replace(/[^\x00-\x7F]/g, '').trim();
  
const supabase = createClient(
  supabaseUrl,
  supabaseKey
);

export default function UpdatePasswordPage() {
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const router = useRouter();

  useEffect(() => {
    // Supabase automatically parses hash parameters (#access_token=...) from the URL
    const { data: authListener } = supabase.auth.onAuthStateChange(async (event, session) => {
      console.log('[Auth] Event triggered:', event);

      if (event === 'PASSWORD_RECOVERY' || session) {
        console.log('[Auth] Recovery session detected and verified.');
        setReady(true);
      }
    });

    return () => {
      authListener.subscription.unsubscribe();
    };
  }, []);

  const handleUpdatePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMessage(null);

    console.log('[Auth] Attempting password update...');

    try {
      const { error } = await supabase.auth.updateUser({
        password: password,
      });

      if (error) throw error;

      console.log('[Auth] Password updated successfully.');
      setMessage({
        type: 'success',
        text: 'Password updated successfully! Redirecting to login...',
      });

      setTimeout(() => {
        router.push('/');
      }, 2000);
    } catch (err: any) {
      console.error('[Auth] Password update error:', err.message);
      setMessage({
        type: 'error',
        text: err.message || 'Failed to update password. Please try requesting a new reset link.',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ maxWidth: '400px', margin: '80px auto', padding: '24px', fontFamily: 'sans-serif' }}>
      <h2>Set New Password</h2>
      <p style={{ color: '#666', fontSize: '14px' }}>Please enter your new password below.</p>

      {message && (
        <div
          style={{
            padding: '12px',
            marginBottom: '16px',
            backgroundColor: message.type === 'success' ? '#e6f4ea' : '#fce8e6',
            color: message.type === 'success' ? '#137333' : '#c5221f',
            borderRadius: '4px',
            fontSize: '14px',
          }}
        >
          {message.text}
        </div>
      )}

      <form onSubmit={handleUpdatePassword}>
        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', marginBottom: '8px', fontSize: '14px', fontWeight: 'bold' }}>
            New Password
          </label>
          <input
            type="password"
            required
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 6 characters"
            style={{ width: '100%', padding: '10px', fontSize: '14px', borderRadius: '4px', border: '1px solid #ccc' }}
          />
        </div>

        <button
          type="submit"
          disabled={loading || !ready}
          style={{
            width: '100%',
            padding: '10px',
            backgroundColor: ready ? '#1a73e8' : '#9aa0a6',
            color: '#fff',
            border: 'none',
            borderRadius: '4px',
            fontSize: '14px',
            fontWeight: 'bold',
            cursor: ready && !loading ? 'pointer' : 'not-allowed',
          }}
        >
          {loading ? 'Updating password...' : ready ? 'Update Password' : 'Verifying reset link...'}
        </button>
      </form>
    </div>
  );
}
