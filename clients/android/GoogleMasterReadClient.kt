package com.elfshell.googlemaster

import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import javax.net.ssl.HttpsURLConnection

/**
 * Standalone Android transport example. Not yet wired into the CiRYVA app.
 * Call only off the main thread. Provide an OAuth access token obtained using
 * a system-browser authorization code + PKCE flow; do NOT embed client secrets
 * or store tokens here.
 */
class GoogleMasterReadClient(
    resourceUrl: String,
    private val tokenProvider: () -> String
) {
    private val origin: String
    private val readNames = setOf(
        "tasks_list_tasklists", "tasks_list_tasks", "tasks_get_task",
        "script_get_project", "script_get_content",
        "script_list_versions", "script_list_deployments",
        "drive_list_files", "drive_get_file", "drive_query_activity",
        "docs_get_document", "sheets_get_spreadsheet", "sheets_get_values",
        "slides_get_presentation", "calendar_list_calendars", "calendar_list_events",
        "gmail_list_messages", "gmail_get_message", "gmail_list_labels",
        "contacts_list_connections", "forms_get_form", "forms_list_responses",
        "meet_list_conferences", "meet_get_space",
        "tasks_get_tasklist",
        "tasks_list_tasks_extended",
        "script_list_user_processes",
        "script_list_script_processes",
        "script_get_metrics",
        "script_get_deployment",
        "drive_get_about",
        "drive_list_file_permissions",
        "drive_get_file_permission",
        "drive_list_file_comments",
        "drive_get_file_comment",
        "drive_list_comment_replies",
        "drive_list_file_revisions",
        "drive_get_file_revision",
        "drive_get_changes_start_token",
        "drive_list_changes",
        "drive_list_shared_drives",
        "drive_get_shared_drive",
        "docs_get_document_tabs",
        "sheets_get_formulas",
        "sheets_get_grid_slice",
        "sheets_get_developer_metadata",
        "slides_get_page",
        "slides_get_page_thumbnail",
        "calendar_get_event",
        "calendar_list_event_instances",
        "calendar_get_calendar",
        "calendar_list_settings",
        "calendar_get_setting",
        "calendar_list_access_rules",
        "calendar_get_access_rule",
        "calendar_get_colors",
        "gmail_get_profile",
        "gmail_get_message_full",
        "gmail_list_threads",
        "gmail_get_thread",
        "gmail_list_drafts",
        "gmail_get_draft",
        "gmail_get_label",
        "gmail_list_history",
        "gmail_get_settings_vacation",
        "gmail_get_settings_imap",
        "gmail_get_settings_pop",
        "gmail_get_settings_language",
        "gmail_get_settings_auto_forwarding",
        "gmail_list_settings_filters",
        "gmail_get_settings_filter",
        "gmail_list_forwarding_addresses",
        "gmail_list_send_as",
        "gmail_get_send_as",
        "gmail_list_delegates",
        "contacts_get_person",
        "contacts_search_contacts",
        "contacts_list_contact_groups",
        "contacts_get_contact_group",
        "contacts_list_other_contacts",
        "forms_get_response",
        "forms_list_watches",
        "meet_get_conference_record",
        "meet_list_participants",
        "meet_get_participant",
        "meet_list_participant_sessions",
        "meet_list_recordings",
        "meet_get_recording",
        "meet_list_transcripts",
        "meet_get_transcript",
        "meet_list_transcript_entries",
        "meet_list_smart_notes",
        "meet_list_members",
        "meet_get_member",
        "calendar_query_freebusy",
  "drive_get_comment_reply",
  "calendar_get_calendar_list_entry",
  "gmail_get_attachment",
  "meet_get_participant_session",
  "meet_get_smart_note",
  "meet_get_transcript_entry"
    )

    private val writeNames = setOf(
        "tasks_create_task",
        "script_create_project",
        "script_update_sources",
        "script_create_version",
        "drive_create_folder",
        "calendar_create_event",
        "sheets_update_values",
        "gmail_create_draft",
        "gmail_send_message",
        "tasks_create_tasklist",
        "tasks_update_tasklist",
        "tasks_delete_tasklist",
        "tasks_patch_task",
        "tasks_delete_task",
        "tasks_move_task",
        "tasks_clear_completed",
        "script_create_deployment",
        "script_update_deployment",
        "script_delete_deployment",
        "drive_create_file",
        "drive_copy_file",
        "drive_update_file",
        "drive_trash_file",
        "drive_restore_file",
        "drive_delete_file",
        "drive_create_permission",
        "drive_update_permission",
        "drive_delete_permission",
        "drive_create_comment",
        "drive_update_comment",
        "drive_delete_comment",
        "drive_create_reply",
        "drive_delete_reply",
        "drive_update_reply",
        "drive_delete_revision",
        "docs_create_document",
        "docs_batch_update",
        "sheets_create_spreadsheet",
        "sheets_append_values",
        "sheets_clear_values",
        "sheets_batch_update_values",
        "sheets_batch_update",
        "slides_create_presentation",
        "slides_batch_update",
        "calendar_patch_event",
        "calendar_delete_event",
        "calendar_move_event",
        "calendar_create_calendar",
        "calendar_patch_calendar",
        "calendar_delete_calendar",
        "calendar_patch_calendar_list",
        "calendar_insert_calendar_list",
        "calendar_delete_calendar_list",
        "calendar_create_acl",
        "calendar_update_acl",
        "calendar_delete_acl",
        "gmail_update_draft",
        "gmail_delete_draft",
        "gmail_send_draft",
        "gmail_create_label",
        "gmail_update_label",
        "gmail_delete_label",
        "gmail_modify_message",
        "gmail_batch_modify_messages",
        "gmail_trash_message",
        "gmail_untrash_message",
        "gmail_modify_thread",
        "gmail_trash_thread",
        "gmail_untrash_thread",
        "gmail_set_vacation",
        "gmail_create_filter",
        "gmail_delete_filter",
        "contacts_create_contact",
        "contacts_update_contact",
        "contacts_delete_contact",
        "contacts_create_group",
        "contacts_update_group",
        "contacts_delete_group",
        "contacts_modify_group_members",
        "forms_create_form",
        "forms_batch_update",
        "forms_set_publish_settings",
        "forms_renew_watch",
        "forms_delete_watch",
        "meet_create_space",
        "meet_patch_space",
        "meet_end_active_conference",
        "meet_create_member",
        "meet_patch_member",
        "meet_delete_member"
    )

    init {
        val uri = URI(resourceUrl)
        require(uri.scheme == "https" && uri.rawPath == "/mcp" &&
                uri.rawUserInfo == null && uri.rawQuery == null &&
                uri.rawFragment == null && uri.port == -1) {
            "An exact HTTPS /mcp resource URL is required"
        }
        origin = "https://" + uri.host
        require(uri.host != null && uri.host.isNotBlank())
    }

    fun capabilities(): JSONObject = request("GET", "/v1/capabilities", null)

    fun callRead(name: String, arguments: JSONObject = JSONObject()): JSONObject {
        require(name in readNames) { "Unsupported or non-read operation" }
        val envelope = request("POST", "/v1/operations/$name", arguments)
        if (!envelope.has("result")) throw ApiException(0, "INVALID_RESPONSE")
        return envelope.optJSONObject("result") ?: throw ApiException(0, "INVALID_RESPONSE")
    }

    /** Executes a scoped Google write directly after one-time OAuth connection approval. */
    fun callWrite(name: String, input: JSONObject): JSONObject {
        require(name in writeNames) { "Unsupported or non-write operation" }
        val envelope = request("POST", "/v1/operations/$name", input)
        return envelope.optJSONObject("result") ?: throw ApiException(0, "INVALID_RESPONSE")
    }

    private fun request(method: String, path: String, input: JSONObject?): JSONObject {
        val token = tokenProvider()
        require(token.length in 8..8192 && token.none { it.isWhitespace() || it.code < 32 }) {
            "A valid OAuth access token is required"
        }
        val payload = input?.toString()?.toByteArray(Charsets.UTF_8)
        require(payload == null || payload.size <= 32 * 1024) {
            "Request exceeds the API limit"
        }
        val connection = URL(origin + path).openConnection() as HttpsURLConnection
        try {
            connection.requestMethod = method
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 12000
            connection.readTimeout = 12000
            connection.useCaches = false
            connection.setRequestProperty("Authorization", "Bearer $token")
            connection.setRequestProperty("Accept", "application/json")
            if (payload != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write(payload) }
            }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val body = stream?.use { inputStream ->
                val out = ByteArrayOutputStream()
                val chunk = ByteArray(8192)
                while (true) {
                    val size = inputStream.read(chunk)
                    if (size < 0) break
                    require(out.size() + size <= 512 * 1024) { "Response too large" }
                    out.write(chunk, 0, size)
                }
                JSONObject(out.toString(Charsets.UTF_8.name()))
            } ?: throw ApiException(status, "INVALID_RESPONSE")
            if (status !in 200..299) {
                val code = body.optString("error", "REMOTE_REQUEST_FAILED")
                throw ApiException(status, if (code.matches(Regex("[A-Z][A-Z0-9_]{0,79}")))
                    code else "REMOTE_REQUEST_FAILED")
            }
            return body
        } finally {
            connection.disconnect()
        }
    }

    class ApiException(val status: Int, val code: String) : Exception(code)
}
