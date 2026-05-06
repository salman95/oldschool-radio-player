const fs = require('fs');
const path = require('path');

/* ---------- Supported audio extensions ---------- */
const AUDIO_EXTENSIONS = new Set([
  '.mp3', '.wav', '.ogg', '.flac', '.m4a',
  '.aac', '.wma', '.opus', '.webm',
]);

/* ---------- Recursive directory scanner ---------- */
function scanDirectory(dirPath) {
  const resolved = path.resolve(dirPath);

  // Security: ensure the directory exists and is actually a directory
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return { files: [], error: `Directory not found: ${dirPath}` };
  }
  if (!stat.isDirectory()) {
    return { files: [], error: `Not a directory: ${dirPath}` };
  }

  const files = [];
  const errors = [];

  function walk(currentPath) {
    let entries;
    try {
      entries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch (err) {
      errors.push(`Cannot read directory: ${currentPath} (${err.message})`);
      return;
    }

    for (const entry of entries) {
      // Skip hidden files/dirs (dotfiles)
      if (entry.name.startsWith('.')) continue;

      const fullPath = path.join(currentPath, entry.name);

      try {
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (AUDIO_EXTENSIONS.has(ext)) {
            let size = 0;
            try {
              const fstat = fs.statSync(fullPath);
              size = fstat.size;
            } catch { /* ignore stat errors */ }

            files.push({
              filename: entry.name,
              filepath: fullPath,
              display_name: stripExtension(entry.name),
              file_size: size,
            });
          }
        }
      } catch (err) {
        errors.push(`Error processing: ${fullPath} (${err.message})`);
      }
    }
  }

  walk(resolved);

  // Sort alphabetically by display name
  files.sort((a, b) => a.display_name.localeCompare(b.display_name));

  return { files, errors, directory: resolved, count: files.length };
}

function stripExtension(name) {
  const lastDot = name.lastIndexOf('.');
  if (lastDot > 0) return name.substring(0, lastDot);
  return name;
}

module.exports = { scanDirectory, AUDIO_EXTENSIONS };
