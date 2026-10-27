package com.wildstring.app.data

import android.content.Context
import android.content.SharedPreferences
import java.security.MessageDigest

/** Local preferences use the stable server/account identity, never a login generation. */
internal object AccountPreferences {
    @Synchronized fun forAccount(context: Context, legacyName: String, serverId: String?, userId: String?, keys: Set<String>): SharedPreferences {
        val identity = if (serverId != null && userId != null) "$serverId:$userId" else null
        val suffix = identity?.let { value -> MessageDigest.getInstance("SHA-256").digest(value.toByteArray()).joinToString("") { "%02x".format(it) } } ?: "signed-out"
        val target = context.getSharedPreferences("$legacyName-account-$suffix", Context.MODE_PRIVATE)
        val legacy = context.getSharedPreferences(legacyName, Context.MODE_PRIVATE)
        if (identity != null && !legacy.contains("preferences_legacy_owner")) {
            val edit = target.edit()
            keys.forEach { key -> if (!target.contains(key)) when (val value = legacy.all[key]) {
                is String -> edit.putString(key, value)
                is Int -> edit.putInt(key, value)
                is Boolean -> edit.putBoolean(key, value)
            } }
            edit.apply()
            legacy.edit().putString("preferences_legacy_owner", identity).apply()
        }
        return target
    }
}
