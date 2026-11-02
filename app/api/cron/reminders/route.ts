import { NextResponse } from 'next/server';
import { Resend } from 'resend';
import { createClient } from '@supabase/supabase-js';

// Initialize Resend & Supabase Admin Client (Bypasses RLS for cron execution)
const resend = new Resend(process.env.RESEND_API_KEY);
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * Helper: Calculates next target timestamp at 09:00 AM in client's timezone
 */
function getNextWorkingHourTimestamp(offsetDays: number, timeZone: string): string {
  try {
    const now = new Date();
    const targetDate = new Date(now.getTime() + offsetDays * 24 * 60 * 60 * 1000);
    const localDateStr = targetDate.toLocaleDateString('en-CA', { timeZone: timeZone || 'UTC' });
    const local9AM = new Date(`${localDateStr}T09:00:00`);
    return local9AM.toISOString();
  } catch (err) {
    console.error(`[Timezone Error] Fallback to UTC for zone ${timeZone}:`, err);
    const fallback = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
    return fallback.toISOString();
  }
}

export async function GET(request: Request) {
  console.log('[Cron Job] Reminders polling started at:', new Date().toISOString());

  try {
    // 1. Authorize Cron request
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      console.warn('[Cron Auth] Unauthorized access attempt detected.');
      return new NextResponse('Unauthorized', { status: 401 });
    }

    const nowIso = new Date().toISOString();

    // 2. Fetch sessions where next_event_time is due, pending docs > 0, and stage < 4
    const { data: sessions, error: fetchError } = await supabaseAdmin
      .from('request_sessions')
      .select(`
        *,
        practitioners(email, firm_name),
        requested_items(document_title, is_uploaded)
      `)
      .gt('pending', 0)
      .lt('reminder_stage', 4)
      .lte('next_event_time', nowIso);

    if (fetchError) {
      console.error('[Supabase Fetch Error]:', fetchError.message);
      return NextResponse.json({ error: fetchError.message }, { status: 500 });
    }

    if (!sessions || sessions.length === 0) {
      console.log('[Cron Job] No sessions due for reminders.');
      return NextResponse.json({ processed: 0 });
    }

    console.log(`[Cron Job] Found ${sessions.length} sessions due for processing.`);
    const results = [];

    // 3. Process each due session
    for (const session of sessions) {
      const sessionId = session.id;
      const stage = session.reminder_stage;
      const clientTz = session.client_timezone || 'UTC';
      const clientEmail = session.client_contact;
      const clientName = session.client_name;
      const practitionerEmail = session.practitioners?.email || 'support@yourdomain.com';
      const practitionerFirm = session.practitioners?.firm_name || 'Your Practitioner';
      
      // Construct direct client portal link using env variable and token
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
      const clientPortalLink = `${appUrl}/${session.token}`;

      // Filter unuploaded items
      const pendingDocs = (session.requested_items || []).filter((i: any) => !i.is_uploaded);
      if (pendingDocs.length === 0) {
        console.log(`[Session ${sessionId}] No pending docs found. Skipping.`);
        continue;
      }

      const docListHtml = pendingDocs.map((i: any) => `<li>${i.document_title}</li>`).join('');
      let nextStage = stage;
      let nextEventTime: string | null = null;
      let emailSubject = '';
      let emailHtml = '';
      let recipient = clientEmail;

      // 4. Evaluate Stage Logic
      if (stage === 0) {
        // Send 1st Mail
        emailSubject = `Action Required: Outstanding Documents for ${clientName}`;
        emailHtml = `
          <p>Hello ${clientName},</p>
          <p>You have a new document request from <strong>${practitionerFirm}</strong>. Please upload your pending documents by visiting your secure portal below:</p>
          <ul>${docListHtml}</ul>
          <p><a href="${clientPortalLink}" style="padding: 10px 15px; background: #000; color: #fff; text-decoration: none; border-radius: 5px;">Open Upload Portal</a></p>
          <p>If the button doesn't work, copy and paste this link: ${clientPortalLink}</p>
        `;
        nextStage = 1;
        nextEventTime = getNextWorkingHourTimestamp(3, clientTz); // +3 days at 9 AM

      } else if (stage === 1) {
        // Send 2nd Mail
        emailSubject = `Reminder: Pending Documents Needed`;
        emailHtml = `
          <p>Hello ${clientName},</p>
          <p>This is a reminder from <strong>${practitionerFirm}</strong> that we are still waiting for your remaining documents:</p>
          <ul>${docListHtml}</ul>
          <p><a href="${clientPortalLink}" style="padding: 10px 15px; background: #000; color: #fff; text-decoration: none; border-radius: 5px;">Open Upload Portal</a></p>
        `;
        nextStage = 2;
        nextEventTime = getNextWorkingHourTimestamp(3, clientTz); // +3 days at 9 AM

      } else if (stage === 2) {
        // Send 3rd Mail
        emailSubject = `Final Notice: Outstanding Document Request`;
        emailHtml = `
          <p>Hello ${clientName},</p>
          <p>This is your final notice from <strong>${practitionerFirm}</strong> to upload your pending items:</p>
          <ul>${docListHtml}</ul>
          <p><a href="${clientPortalLink}" style="padding: 10px 15px; background: #000; color: #fff; text-decoration: none; border-radius: 5px;">Open Upload Portal</a></p>
        `;
        nextStage = 3;
        nextEventTime = getNextWorkingHourTimestamp(2, clientTz); // +2 days at 9 AM before escalation

      } else if (stage === 3) {
        // Send Escalation Mail to Practitioner
        recipient = practitionerEmail;
        emailSubject = `Escalation: Unresponsive Client - ${clientName}`;
        emailHtml = `
          <p>Client <strong>${clientName}</strong> (${clientEmail}) has not responded after 3 automated reminder attempts.</p>
          <p>Pending items: <ul>${docListHtml}</ul></p>
        `;
        nextStage = 4;
        nextEventTime = null; // Clear timer
      }

      // 5. Dispatch Email via Resend
      const senderAddress = process.env.NODE_ENV === 'development' 
        ? 'Acme <onboarding@resend.dev>' 
        : 'Document Portal <reminders@yourdomain.com>';

      const { error: sendError } = await resend.emails.send({
        from: senderAddress,
        to: recipient,
        replyTo: practitionerEmail,
        subject: emailSubject,
        html: emailHtml,
      });

      if (sendError) {
        console.error(`[Resend Error] Failed to send email for session ${sessionId} at stage ${stage}:`, sendError.message);
        continue;
      }

      console.log(`[Email Sent] Stage ${stage} email sent successfully for session ${sessionId} to ${recipient}`);

      // 6. Update Database State
      const { error: updateError } = await supabaseAdmin
        .from('request_sessions')
        .update({
          reminder_stage: nextStage,
          last_event_time: nowIso,
          next_event_time: nextEventTime,
        })
        .eq('id', sessionId);

      if (updateError) {
        console.error(`[DB Update Error] Failed to update session ${sessionId}:`, updateError.message);
      } else {
        console.log(`[DB Updated] Session ${sessionId} advanced to stage ${nextStage}. Next event: ${nextEventTime}`);
      }

      results.push({ sessionId, executedStage: stage, advancedTo: nextStage });
    }

    return NextResponse.json({ success: true, processedCount: results.length, results });
  } catch (err: any) {
    console.error('[Cron Execution Critical Error]:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}