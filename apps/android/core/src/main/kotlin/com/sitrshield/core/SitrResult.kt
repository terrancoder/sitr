package com.sitrshield.core

/**
 * Discriminated result — port of extension/src/lib/result.ts. Every
 * fallible operation returns Ok or Err instead of throwing across module
 * boundaries; error messages are user-readable and never matched on.
 */
sealed class SitrResult<out T> {
    data class Ok<T>(val value: T) : SitrResult<T>()
    data class Err(val message: String) : SitrResult<Nothing>()

    val isOk: Boolean get() = this is Ok
    fun getOrNull(): T? = (this as? Ok)?.value
    fun errorOrNull(): String? = (this as? Err)?.message
}
