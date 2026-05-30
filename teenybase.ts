// autolead — action feed for Min's social presence
// v1: single shared workspace, no auth, no owner_id. Forward-compat to multi-user
// later via owner_id + auth.uid rules.

import { sql, tableField, baseFields, createdTrigger, updatedTrigger } from 'teenybase'

// ───────── feeds ─────────
// One logical inbound feed. v1 has exactly one row ('default'). Multi-feed UI later.
// The feed's directive is the active skill (versioned via skill_snapshots), not stored here.
const feeds = {
  name: 'feeds',
  autoSetUid: true,
  fields: [
    ...baseFields,
    tableField('slug', 'text', 'text', { notNull: true, unique: true }),
    tableField('name', 'text', 'text', { notNull: true }),
    tableField('feed_fill_target', 'integer', 'integer', { notNull: true, default: sql`50` }),
    tableField('skill_name', 'text', 'text', { notNull: true, default: sql`'blitz-social'` }),
  ],
  extensions: [
    { name: 'rules', listRule: 'true', viewRule: 'true', createRule: 'true', updateRule: 'true', deleteRule: 'true' },
  ],
  triggers: [createdTrigger, updatedTrigger],
}

// ───────── skill_snapshots ─────────
// Content-addressable. hash = sha256 of content. INSERT OR IGNORE on hash makes
// duplicates free. feed_items and examples reference hash so we can meta-reason
// about which skill version drove each outcome.
const skill_snapshots = {
  name: 'skill_snapshots',
  autoSetUid: false,
  fields: [
    tableField('hash', 'text', 'text', { primary: true, notNull: true }),
    tableField('skill_name', 'text', 'text', { notNull: true }),
    tableField('content', 'text', 'text', { notNull: true }),
    tableField('notes', 'text', 'text', {}),
    tableField('captured_at', 'date', 'timestamp', { notNull: true, default: sql`CURRENT_TIMESTAMP` }),
  ],
  extensions: [
    { name: 'rules', listRule: 'true', viewRule: 'true', createRule: 'true', updateRule: 'true', deleteRule: 'true' },
  ],
}

// ───────── feed_items ─────────
// Workflow + audit. One row per candidate from creation through send or rejection.
// Status state machine encodes the append-only audit trail.
//
// edit_chain JSON shape (interleaved Gmail-style thread):
// [
//   { role: 'cmo', v: 1, subject: '...', body: '...', draft: '...', ts: '...' },
//   { role: 'user_feedback', text: 'make it shorter', ts: '...' },
//   { role: 'cmo', v: 2, subject: 'Re: ...', body: '...', draft: '...', ts: '...' },
//   { role: 'user_manual_edit', draft: '...', ts: '...' }
// ]
const feed_items = {
  name: 'feed_items',
  autoSetUid: true,
  fields: [
    ...baseFields,
    tableField('feed_id', 'text', 'text', { notNull: true, foreignKey: { table: 'feeds', column: 'id' } }),

    // status: draft | approved | sent | send_failed | rejected
    tableField('status', 'text', 'text', { notNull: true, default: sql`'draft'` }),

    // taxonomy
    tableField('channel', 'text', 'text', { notNull: true }),            // x | reddit | discord | etc
    tableField('audience', 'text', 'text', {}),                          // customer | investor | influencer | peer | community
    tableField('message_type', 'text', 'text', {}),                      // post | dm | reply | comment | thread
    tableField('goal', 'text', 'text', {}),                              // signup | feedback | awareness | reply-jack | follow-up

    // EV
    tableField('ev_score', 'number', 'real', {}),
    tableField('ev_reasoning', 'text', 'text', {}),                      // free-text agent reasoning

    // CMO-voice triage summary, generated at research time alongside the draft
    tableField('summary_subject', 'text', 'text', { notNull: true }),
    tableField('summary_body', 'text', 'text', {}),

    // Structured parent context (the thread/post/DM being responded to)
    tableField('parent_text', 'text', 'text', {}),
    tableField('parent_author_handle', 'text', 'text', {}),
    tableField('parent_author_meta', 'json', 'json', {}),                // name, follower_count, verified, etc
    tableField('parent_engagement', 'json', 'json', {}),                 // {likes, retweets, replies, captured_at}
    tableField('parent_posted_at', 'date', 'timestamp', {}),
    tableField('parent_url', 'url', 'text', {}),

    // Recipient for DMs/replies, indexed for "already messaged" checks
    tableField('target_handle', 'text', 'text', {}),

    // Draft + versioned thread
    tableField('current_draft', 'text', 'text', { notNull: true }),
    tableField('edit_chain', 'json', 'json', {}),

    // Provenance
    tableField('skill_snapshot_hash', 'text', 'text', { foreignKey: { table: 'skill_snapshots', column: 'hash' } }),
    tableField('related_example_ids', 'json', 'json', {}),

    // Send idempotency + failure surface
    tableField('send_lock_token', 'text', 'text', {}),
    tableField('send_attempts', 'integer', 'integer', { notNull: true, default: sql`0` }),
    tableField('send_error', 'text', 'text', {}),

    // Pending-action flags — flipped by UI forms, drained by the autolead skill
    tableField('revision_pending', 'bool', 'boolean', { notNull: true, default: sql`0` }),
    tableField('revision_feedback', 'text', 'text', {}),
    tableField('send_pending', 'bool', 'boolean', { notNull: true, default: sql`0` }),

    tableField('approved_at', 'date', 'timestamp', {}),
    tableField('sent_at', 'date', 'timestamp', {}),
  ],
  indexes: [
    { fields: ['feed_id', 'status'] },
    { fields: ['target_handle', 'status'] },
  ],
  extensions: [
    { name: 'rules', listRule: 'true', viewRule: 'true', createRule: 'true', updateRule: 'true', deleteRule: 'true' },
  ],
  triggers: [createdTrigger, updatedTrigger],
}

// ───────── examples ─────────
// Learning surface. Append-only, one row per sent message. Drafting agents query
// by audience + channel + message_type, retrieve top N by recency + FTS5 relevance,
// study edit_chain to learn how Min refines drafts.
const examples = {
  name: 'examples',
  autoSetUid: true,
  fields: [
    ...baseFields,
    tableField('source_feed_item_id', 'text', 'text', { foreignKey: { table: 'feed_items', column: 'id' } }),

    tableField('audience', 'text', 'text', {}),
    tableField('channel', 'text', 'text', { notNull: true }),
    tableField('message_type', 'text', 'text', {}),
    tableField('goal', 'text', 'text', {}),

    tableField('outcome', 'text', 'text', {}),                          // approved-clean | edited-once | edited-many | edited-manual
    tableField('iteration_count', 'integer', 'integer', { notNull: true, default: sql`1` }),

    tableField('initial_draft', 'text', 'text', {}),                    // FTS5
    tableField('final_sent', 'text', 'text', {}),                       // FTS5
    tableField('edit_chain', 'json', 'json', {}),
    tableField('parent_context', 'text', 'text', {}),                   // FTS5 — flattened JSON of structured parent at send time

    tableField('notes', 'text', 'text', {}),                            // FTS5

    tableField('skill_snapshot_hash', 'text', 'text', { foreignKey: { table: 'skill_snapshots', column: 'hash' } }),
    tableField('feed_id', 'text', 'text', { foreignKey: { table: 'feeds', column: 'id' } }),

    tableField('sent_at', 'date', 'timestamp', {}),
  ],
  fullTextSearch: {
    enabled: true,
    fields: ['initial_draft', 'final_sent', 'notes', 'parent_context'],
  },
  extensions: [
    // Internal-only: queried via custom worker routes that do audience+channel+type ranking.
    { name: 'rules', listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null },
  ],
  triggers: [createdTrigger, updatedTrigger],
}

export default {
  appName: 'autolead',
  appUrl: 'https://autolead.app.blitz.dev',
  jwtSecret: '$JWT_SECRET_MAIN',
  tables: [feeds, skill_snapshots, feed_items, examples],
}
