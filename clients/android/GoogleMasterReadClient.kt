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
        "calendar_query_freebusy"
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
