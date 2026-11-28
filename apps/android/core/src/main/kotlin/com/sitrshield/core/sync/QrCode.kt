package com.sitrshield.core.sync

/**
 * A minimal QR code encoder (ISO/IEC 18004) for showing the pairing code:
 * error correction level M, versions 1–6, alphanumeric mode when the text
 * allows it (a pairing code always does: Crockford Base32 and '-'), byte
 * mode otherwise. Written here because the apps take no third-party
 * runtime dependency (docs/mobile.md); QrCodeTest checks the output with
 * zxing's decoder. The QR is only a picture of the canonical code
 * (sync-protocol.md §Pairing code), never a protocol change.
 */
object QrCode {
    // Level M, versions 1..6: data codewords, blocks (all the same size
    // up to version 6), error-correction codewords per block.
    private val DATA_CODEWORDS = intArrayOf(16, 28, 44, 64, 86, 108)
    private val BLOCKS = intArrayOf(1, 1, 1, 2, 2, 4)
    private val EC_PER_BLOCK = intArrayOf(10, 16, 26, 18, 24, 16)
    private const val ALPHANUMERIC = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:"

    /** The modules, `[row][column]`, true = dark. Without the quiet zone. */
    fun encode(text: String): Array<BooleanArray> {
        val (version, codewords) = codewords(text)
        return (0..7).map { draw(version, codewords, it) }.minBy(::penalty)
    }

    private fun codewords(text: String): Pair<Int, IntArray> {
        val alnum = text.all { it in ALPHANUMERIC }
        val bytes = text.toByteArray(Charsets.UTF_8)
        val payloadBits = if (alnum) text.length / 2 * 11 + text.length % 2 * 6 else bytes.size * 8
        // Character count field: 9 bits (alphanumeric) or 8 (byte) up to version 9.
        val needed = 4 + (if (alnum) 9 else 8) + payloadBits
        val version = (1..6).firstOrNull { needed <= DATA_CODEWORDS[it - 1] * 8 }
            ?: throw IllegalArgumentException("text too long for a version 1-6 QR code")
        val capacity = DATA_CODEWORDS[version - 1] * 8

        val bits = ArrayList<Boolean>(capacity)
        fun put(value: Int, count: Int) {
            for (i in count - 1 downTo 0) bits.add((value ushr i) and 1 == 1)
        }
        if (alnum) {
            put(0b0010, 4)
            put(text.length, 9)
            for (i in text.indices step 2) {
                val a = ALPHANUMERIC.indexOf(text[i])
                if (i + 1 < text.length) put(a * 45 + ALPHANUMERIC.indexOf(text[i + 1]), 11) else put(a, 6)
            }
        } else {
            put(0b0100, 4)
            put(bytes.size, 8)
            for (b in bytes) put(b.toInt() and 0xff, 8)
        }
        put(0, minOf(4, capacity - bits.size)) // terminator
        put(0, (8 - bits.size % 8) % 8)
        val data = IntArray(capacity / 8)
        for (i in 0 until bits.size / 8) {
            for (j in 0 until 8) if (bits[i * 8 + j]) data[i] = data[i] or (0x80 ushr j)
        }
        for (i in bits.size / 8 until data.size) data[i] = if ((i - bits.size / 8) % 2 == 0) 0xEC else 0x11

        // Split into blocks, add error correction, interleave.
        val blocks = BLOCKS[version - 1]
        val ecLength = EC_PER_BLOCK[version - 1]
        val perBlock = data.size / blocks
        val dataBlocks = (0 until blocks).map { data.copyOfRange(it * perBlock, (it + 1) * perBlock) }
        val ecBlocks = dataBlocks.map { reedSolomon(it, ecLength) }
        val out = ArrayList<Int>()
        for (i in 0 until perBlock) dataBlocks.forEach { out.add(it[i]) }
        for (i in 0 until ecLength) ecBlocks.forEach { out.add(it[i]) }
        return version to out.toIntArray()
    }

    // GF(256) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1.
    private val EXP = IntArray(256)
    private val LOG = IntArray(256)

    init {
        var x = 1
        for (i in 0 until 255) {
            EXP[i] = x
            LOG[x] = i
            x = x shl 1
            if (x and 0x100 != 0) x = x xor 0x11D
        }
    }

    private fun mul(a: Int, b: Int) = if (a == 0 || b == 0) 0 else EXP[(LOG[a] + LOG[b]) % 255]

    private fun reedSolomon(data: IntArray, ecLength: Int): IntArray {
        // Generator: product of (x - α^i) for i < ecLength, highest degree first.
        var gen = intArrayOf(1)
        for (i in 0 until ecLength) {
            val next = IntArray(gen.size + 1)
            for (j in gen.indices) {
                next[j] = next[j] xor gen[j]
                next[j + 1] = next[j + 1] xor mul(gen[j], EXP[i])
            }
            gen = next
        }
        val rem = IntArray(ecLength)
        for (d in data) {
            val factor = d xor rem[0]
            System.arraycopy(rem, 1, rem, 0, ecLength - 1)
            rem[ecLength - 1] = 0
            for (j in 0 until ecLength) rem[j] = rem[j] xor mul(gen[j + 1], factor)
        }
        return rem
    }

    private fun draw(version: Int, codewords: IntArray, mask: Int): Array<BooleanArray> {
        val size = 17 + 4 * version
        val dark = Array(size) { BooleanArray(size) }
        val fixed = Array(size) { BooleanArray(size) }
        fun set(row: Int, col: Int, value: Boolean) {
            dark[row][col] = value
            fixed[row][col] = true
        }

        // Finder patterns with their light separators.
        for ((r0, c0) in listOf(0 to 0, 0 to size - 7, size - 7 to 0)) {
            for (dr in -1..7) for (dc in -1..7) {
                val r = r0 + dr
                val c = c0 + dc
                if (r !in 0 until size || c !in 0 until size) continue
                val inside = dr in 0..6 && dc in 0..6
                set(r, c, inside && (dr == 0 || dr == 6 || dc == 0 || dc == 6 || (dr in 2..4 && dc in 2..4)))
            }
        }
        // Timing patterns.
        for (i in 8 until size - 8) {
            set(6, i, i % 2 == 0)
            set(i, 6, i % 2 == 0)
        }
        // The single alignment pattern of versions 2–6.
        if (version >= 2) {
            val center = size - 7
            for (dr in -2..2) for (dc in -2..2) {
                set(center + dr, center + dc, maxOf(Math.abs(dr), Math.abs(dc)) != 1)
            }
        }
        // Format information (level M = 00, then the mask), both copies,
        // and the dark module. Versions below 7 carry no version field.
        val format = (mask shl 10 or bch(mask)) xor 0x5412
        fun bit(i: Int) = (format ushr i) and 1 == 1
        for (i in 0..5) set(i, 8, bit(i))
        set(7, 8, bit(6))
        set(8, 8, bit(7))
        set(8, 7, bit(8))
        for (i in 9 until 15) set(8, 14 - i, bit(i))
        for (i in 0 until 8) set(8, size - 1 - i, bit(i))
        for (i in 8 until 15) set(size - 15 + i, 8, bit(i))
        set(size - 8, 8, true)

        // Data, in the two-column zigzag from the bottom right.
        var i = 0
        var right = size - 1
        while (right >= 1) {
            if (right == 6) right = 5 // skip the vertical timing column
            val upward = (right + 1) and 2 == 0
            for (vert in 0 until size) {
                val row = if (upward) size - 1 - vert else vert
                for (j in 0..1) {
                    val col = right - j
                    if (fixed[row][col] || i >= codewords.size * 8) continue
                    dark[row][col] = (codewords[i ushr 3] ushr (7 - (i and 7))) and 1 == 1
                    i++
                }
            }
            right -= 2
        }
        for (row in 0 until size) for (col in 0 until size) {
            if (!fixed[row][col] && masked(mask, row, col)) dark[row][col] = !dark[row][col]
        }
        return dark
    }

    /** The 10 BCH bits for the 5 format data bits (level M = 00 + mask). */
    private fun bch(mask: Int): Int {
        var rem = mask
        repeat(10) { rem = (rem shl 1) xor ((rem ushr 9) * 0x537) }
        return rem
    }

    private fun masked(mask: Int, row: Int, col: Int): Boolean = when (mask) {
        0 -> (row + col) % 2 == 0
        1 -> row % 2 == 0
        2 -> col % 3 == 0
        3 -> (row + col) % 3 == 0
        4 -> (row / 2 + col / 3) % 2 == 0
        5 -> row * col % 2 + row * col % 3 == 0
        6 -> (row * col % 2 + row * col % 3) % 2 == 0
        else -> ((row + col) % 2 + row * col % 3) % 2 == 0
    }

    /** The standard's mask penalty: lower scans more reliably. */
    private fun penalty(m: Array<BooleanArray>): Int {
        val size = m.size
        var score = 0
        val finderLike = listOf(
            booleanArrayOf(true, false, true, true, true, false, true, false, false, false, false),
            booleanArrayOf(false, false, false, false, true, false, true, true, true, false, true),
        )
        for (horizontal in listOf(true, false)) {
            for (a in 0 until size) {
                fun at(b: Int) = if (horizontal) m[a][b] else m[b][a]
                var run = 1
                for (b in 1..size) {
                    if (b < size && at(b) == at(b - 1)) {
                        run++
                    } else {
                        if (run >= 5) score += run - 2
                        run = 1
                    }
                }
                for (b in 0..size - 11) {
                    if (finderLike.any { p -> p.indices.all { at(b + it) == p[it] } }) score += 40
                }
            }
        }
        for (r in 0 until size - 1) for (c in 0 until size - 1) {
            val v = m[r][c]
            if (m[r][c + 1] == v && m[r + 1][c] == v && m[r + 1][c + 1] == v) score += 3
        }
        val darkCount = m.sumOf { row -> row.count { it } }
        val total = size * size
        score += (Math.abs(darkCount * 20 - total * 10) + total - 1) / total * 10 - 10
        return score
    }
}
