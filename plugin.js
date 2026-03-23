class Plugin extends AppPlugin {
    onLoad() {
        this._statusItem = null;

        // --- Status bar item ---
        this._statusItem = this.ui.addStatusBarItem({
            icon: "download",
            label: "Export to Markdown",
            tooltip: "Click to export all collections to Markdown",
            onClick: () => this._runExport(),
        });

        // --- Sidebar button ---
        this.ui.addSidebarItem({
            label: "Export to Markdown",
            icon: "download",
            tooltip: "Export all collections to Markdown files",
            onClick: () => this._runExport(),
        });

        // --- Command palette ---
        this.ui.addCommandPaletteCommand({
            label: "Export all collections to Markdown",
            icon: "download",
            onSelected: () => this._runExport(),
        });
    }

    onUnload() {}

    // -------------------------------------------------------------------------
    // Export orchestration
    // -------------------------------------------------------------------------

    async _runExport() {
        this._statusItem?.setLabel("Exporting…");
        this._statusItem?.setIcon("refresh");

        try {
            const collections = await this.data.getAllCollections();
            const files = [];

            for (const collection of collections) {
                const collectionFiles = await this._exportCollection(collection);
                files.push(...collectionFiles);
            }

            this._downloadAsZip(files);

            const timeStr = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
            this._statusItem?.setLabel(`Exported at ${timeStr}`);
            this._statusItem?.setIcon("download");

            this.ui.addToaster({
                title: "Export complete",
                message: `${files.length} Markdown file${files.length !== 1 ? "s" : ""} downloaded.`,
                dismissible: true,
                autoDestroyTime: 4000,
            });
        } catch (err) {
            console.error("Markdown export failed:", err);
            this._statusItem?.setLabel("Export failed");
            this._statusItem?.setIcon("alert-triangle");

            this.ui.addToaster({
                title: "Export failed",
                message: String(err),
                dismissible: true,
            });
        }
    }

    // -------------------------------------------------------------------------
    // Per-collection export
    // -------------------------------------------------------------------------

    async _exportCollection(collection) {
        const collectionName = this._safeName(collection.getName());
        const records = await collection.getAllRecords();
        const files = [];

        for (const record of records) {
            const md = await this._recordToMarkdown(record);
            if (md !== null) {
                files.push({
                    name: `${collectionName}/${this._safeName(record.getName())}.md`,
                    content: md,
                });
            }
        }

        return files;
    }

    // -------------------------------------------------------------------------
    // Record → Markdown
    // -------------------------------------------------------------------------

    async _recordToMarkdown(record) {
        // Try the built-in experimental markdown export first
        const result = await record.getAsMarkdown({ experimental: true });
        if (result) return result.content;

        // Fallback: build manually
        const lines = [];

        const props = record.getAllProperties();
        const frontmatter = this._buildFrontmatter(record, props);
        if (frontmatter) {
            lines.push("---", frontmatter, "---", "");
        }

        lines.push(`# ${record.getName()}`, "");

        try {
            const lineItems = await record.getLineItems(false);
            lines.push(...this._lineItemsToMarkdown(lineItems, 0));
        } catch (_) {
            // Not all records support line items
        }

        return lines.join("\n");
    }

    _buildFrontmatter(record, props) {
        const entries = [];

        const createdAt = record.getCreatedAt();
        const updatedAt = record.getUpdatedAt();
        if (createdAt) entries.push(`created: "${createdAt.toISOString()}"`);
        if (updatedAt) entries.push(`updated: "${updatedAt.toISOString()}"`);

        for (const prop of props) {
            const key = this._yamlKey(prop.name);
            if (!prop.values() || prop.values().length === 0) continue;

            const dates = prop.dates();
            if (dates.length > 0) {
                const fmt = dates.map(d => d.toISOString().split("T")[0]);
                entries.push(fmt.length === 1
                    ? `${key}: "${fmt[0]}"`
                    : `${key}:\n${fmt.map(v => `  - "${v}"`).join("\n")}`);
                continue;
            }

            const choiceLabels = prop.selectedChoiceLabels();
            if (choiceLabels.length > 0) {
                entries.push(choiceLabels.length === 1
                    ? `${key}: "${this._yamlEscape(choiceLabels[0])}"`
                    : `${key}:\n${choiceLabels.map(v => `  - "${this._yamlEscape(v)}"`).join("\n")}`);
                continue;
            }

            const users = prop.users();
            if (users.length > 0) {
                const names = users.map(u => u.getDisplayName() || u.guid);
                entries.push(names.length === 1
                    ? `${key}: "${this._yamlEscape(names[0])}"`
                    : `${key}:\n${names.map(v => `  - "${this._yamlEscape(v)}"`).join("\n")}`);
                continue;
            }

            const numbers = prop.numbers();
            if (numbers.length > 0) {
                entries.push(numbers.length === 1
                    ? `${key}: ${numbers[0]}`
                    : `${key}:\n${numbers.map(v => `  - ${v}`).join("\n")}`);
                continue;
            }

            const texts = prop.texts();
            if (texts.length > 0) {
                entries.push(texts.length === 1
                    ? `${key}: "${this._yamlEscape(texts[0])}"`
                    : `${key}:\n${texts.map(v => `  - "${this._yamlEscape(v)}"`).join("\n")}`);
            }
        }

        return entries.join("\n");
    }

    _lineItemsToMarkdown(items, depth) {
        const lines = [];
        for (const item of items) {
            const indent = "  ".repeat(depth);
            const text = this._segmentsToText(item.segments || []);

            switch (item.type) {
                case "task":
                    lines.push(`${indent}- [${item.isTaskCompleted() ? "x" : " "}] ${text}`);
                    break;
                case "heading": {
                    const size = item.getHeadingSize?.() ?? 1;
                    lines.push(`${"#".repeat(Math.min(size + 1, 6))} ${text}`);
                    break;
                }
                case "ulist":  lines.push(`${indent}- ${text}`); break;
                case "olist":  lines.push(`${indent}1. ${text}`); break;
                case "quote":  lines.push(`> ${text}`); break;
                case "block": {
                    const style = item.getBlockStyle?.();
                    if (style === "note")         lines.push(`> **Note:** ${text}`);
                    else if (style === "warning") lines.push(`> **Warning:** ${text}`);
                    else                          lines.push(`> ${text}`);
                    break;
                }
                case "br":
                case "empty":
                    lines.push("");
                    break;
                default:
                    if (text.trim()) lines.push(`${indent}${text}`);
                    break;
            }

            if (item.children?.length > 0) {
                lines.push(...this._lineItemsToMarkdown(item.children, depth + 1));
            }
        }
        return lines;
    }

    _segmentsToText(segments) {
        return segments.map(seg => {
            switch (seg.type) {
                case "bold":    return `**${seg.text}**`;
                case "italic":  return `*${seg.text}*`;
                case "code":    return `\`${seg.text}\``;
                case "link":    return `<${seg.text}>`;
                case "linkobj": return `[${seg.text?.title ?? ""}](${seg.text?.link ?? ""})`;
                default:        return String(seg.text ?? "");
            }
        }).join("");
    }

    // -------------------------------------------------------------------------
    // ZIP download (no external deps)
    // -------------------------------------------------------------------------

    _downloadAsZip(files) {
        const encoder = new TextEncoder();
        const localHeaders = [];
        const centralDir = [];
        let offset = 0;

        for (const file of files) {
            const nameBytes = encoder.encode(file.name);
            const dataBytes = encoder.encode(file.content);
            const crc = this._crc32(dataBytes);
            const date = this._dosDate(new Date());

            const localHeader = new Uint8Array([
                0x50, 0x4B, 0x03, 0x04,
                0x14, 0x00, 0x00, 0x00, 0x00, 0x00,
                date[0], date[1], date[2], date[3],
                ...this._u32(crc),
                ...this._u32(dataBytes.length),
                ...this._u32(dataBytes.length),
                ...this._u16(nameBytes.length),
                0x00, 0x00,
                ...nameBytes,
            ]);

            localHeaders.push(localHeader, dataBytes);

            const cdEntry = new Uint8Array([
                0x50, 0x4B, 0x01, 0x02,
                0x14, 0x00, 0x14, 0x00,
                0x00, 0x00, 0x00, 0x00,
                date[0], date[1], date[2], date[3],
                ...this._u32(crc),
                ...this._u32(dataBytes.length),
                ...this._u32(dataBytes.length),
                ...this._u16(nameBytes.length),
                0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                ...this._u32(offset),
                ...nameBytes,
            ]);

            centralDir.push(cdEntry);
            offset += localHeader.length + dataBytes.length;
        }

        const cdOffset = offset;
        const cdSize = centralDir.reduce((s, b) => s + b.length, 0);

        const eocd = new Uint8Array([
            0x50, 0x4B, 0x05, 0x06,
            0x00, 0x00, 0x00, 0x00,
            ...this._u16(files.length),
            ...this._u16(files.length),
            ...this._u32(cdSize),
            ...this._u32(cdOffset),
            0x00, 0x00,
        ]);

        const parts = [...localHeaders, ...centralDir, eocd];
        const total = parts.reduce((s, b) => s + b.length, 0);
        const buffer = new Uint8Array(total);
        let pos = 0;
        for (const part of parts) { buffer.set(part, pos); pos += part.length; }

        const blob = new Blob([buffer], { type: "application/zip" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `thymer-export-${new Date().toISOString().slice(0, 10)}.zip`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    _u16(n) { return [n & 0xFF, (n >> 8) & 0xFF]; }
    _u32(n) { return [n & 0xFF, (n >> 8) & 0xFF, (n >> 16) & 0xFF, (n >> 24) & 0xFF]; }

    _dosDate(d) {
        const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1));
        const date = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate());
        return [time & 0xFF, (time >> 8) & 0xFF, date & 0xFF, (date >> 8) & 0xFF];
    }

    _crc32(buf) {
        if (!Plugin._crc32Table) {
            Plugin._crc32Table = new Uint32Array(256);
            for (let i = 0; i < 256; i++) {
                let c = i;
                for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
                Plugin._crc32Table[i] = c;
            }
        }
        let crc = 0xFFFFFFFF;
        for (let i = 0; i < buf.length; i++) {
            crc = Plugin._crc32Table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
        }
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    _safeName(name) {
        return (name || "Untitled").replace(/[/\\?%*:|"<>]/g, "-").trim() || "Untitled";
    }

    _yamlKey(name) {
        return (name || "field").toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
    }

    _yamlEscape(str) {
        return String(str ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    }
}
