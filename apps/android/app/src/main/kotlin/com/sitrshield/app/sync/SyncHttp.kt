package com.sitrshield.app.sync

import com.sitrshield.core.sync.SyncCrypto
import com.sitrshield.core.sync.SyncHttpResponse
import com.sitrshield.core.sync.SyncTransport
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * THE APP'S ONLY HTTP CALL SITE — the Android counterpart of the
 * extension's single fetch() in sync/client.ts. docs/data-flow.md invites
 * auditors to verify by grep; keep it true. Plain HttpURLConnection: no
 * OkHttp, no interceptors, no caches (threat-model.md T4).
 */
class SyncHttp : SyncTransport {
    @Throws(IOException::class)
    override fun request(
        method: String,
        url: String,
        headers: Map<String, String>,
        body: ByteArray?,
    ): SyncHttpResponse {
        val connection = URL(url).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = method
            connection.connectTimeout = 10_000
            connection.readTimeout = 15_000
            connection.useCaches = false
            for ((name, value) in headers) connection.setRequestProperty(name, value)
            if (body != null) {
                connection.doOutput = true
                connection.outputStream.use { it.write(body) }
            }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream
            else connection.errorStream
            // One byte past the protocol's blob limit is enough to tell an
            // oversized body from a valid one (SyncCrypto.open rejects it);
            // the rest is never read into memory.
            val bytes = stream?.use { input ->
                val out = java.io.ByteArrayOutputStream()
                val chunk = ByteArray(8192)
                while (out.size() <= SyncCrypto.MAX_BLOB_BYTES) {
                    val n = input.read(chunk)
                    if (n < 0) break
                    out.write(chunk, 0, n)
                }
                out.toByteArray()
            } ?: ByteArray(0)
            return SyncHttpResponse(status, connection.getHeaderField("ETag"), bytes)
        } finally {
            connection.disconnect()
        }
    }
}
