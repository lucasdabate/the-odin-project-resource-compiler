const fs = require('fs/promises');
const crypto = require('crypto');
const path = require('path');

// --- CONFIGURATION ---
const STATE_FILE = './state.json';
const DIFF_FILE = './diff_report.md';
const COMPILED_DIR = './compiled';
const CACHE_DIR = './lessons_cache';

const ALLOWED_COURSES = [
    'foundations',
    'intermediate_html_css',
    'advanced_html_css',
    'javascript',
    'react',
    'nodeJS',
    'databases',
];

const GITHUB_TOKEN = ''; 
const HEADERS = GITHUB_TOKEN ? { 'Authorization': `token ${GITHUB_TOKEN}` } : {};

const JINA_API = 'https://r.jina.ai/';
const REPO_CURRICULUM_TREE = 'https://api.github.com/repos/TheOdinProject/curriculum/git/trees/main?recursive=1';
const REPO_CURRICULUM_RAW = 'https://raw.githubusercontent.com/TheOdinProject/curriculum/main';

// --- UTILITIES ---
const log = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
const hashString = (str) => crypto.createHash('sha256').update(str).digest('hex');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const isYouTube = (url) => url.includes('youtube.com') || url.includes('youtu.be');

async function fetchWithRetry(url, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(url, { headers: HEADERS });
            if (!res.ok) throw new Error(`HTTP ${res.status} - ${res.statusText}`);
            return await res.text();
        } catch (err) {
            if (i === retries - 1) throw err;
            log(`Retrying fetch for ${url}... (${i + 1}/${retries})`);
            await sleep(2000);
        }
    }
}

// --- CORE LOGIC ---

async function getCurriculumTree() {
    log('Fetching full curriculum tree directly from TheOdinProject/curriculum...');
    const res = await fetch(REPO_CURRICULUM_TREE, { headers: HEADERS });
    
    if (!res.ok) throw new Error(`Failed to fetch repo tree. HTTP ${res.status}`);
    
    const data = await res.json();
    
    const mdFiles = data.tree.filter(item => {
        if (item.type !== 'blob' || !item.path.endsWith('.md')) return false;
        
        const pathParts = item.path.split('/');
        if (pathParts.length < 2) return false; 
        
        const courseFolder = pathParts[0];
        return ALLOWED_COURSES.includes(courseFolder);
    });

    const lessonsMap = [];
    for (const file of mdFiles) {
        const pathParts = file.path.split('/');
        lessonsMap.push({
            github_path: `/${file.path}`,
            course: pathParts[0],
            module: pathParts.length > 2 ? pathParts[1] : 'general'
        });
    }
    
    return lessonsMap;
}

function extractExternalLinks(markdown) {
    const links = [];
    const sectionsRegex = /###\s*(Assignment|Additional Resources)[\s\S]*?(?=###|$)/gi;
    let sectionMatch;
    
    while ((sectionMatch = sectionsRegex.exec(markdown)) !== null) {
        const sectionText = sectionMatch[0];
        const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g;
        let linkMatch;
        while ((linkMatch = linkRegex.exec(sectionText)) !== null) {
            links.push({ title: linkMatch[1], url: linkMatch[2] });
        }
    }
    return links;
}

async function fetchJinaMarkdown(url) {
    if (isYouTube(url)) {
        return `> **Video Resource:** [Watch on YouTube](${url}) *(Transcription skipped)*\n`;
    }

    log(`  -> Jina extracting: ${url}`);
    try {
        const res = await fetch(`${JINA_API}${url}`);
        if (!res.ok) return `> Failed to fetch external resource: ${url}\n`;
        return await res.text();
    } catch (err) {
        return `> Error fetching external resource: ${url}\n`;
    }
}

async function run() {
    log('Starting Odin Project Compiler & Differ...');
    
    let state = {};
    try {
        const stateData = await fs.readFile(STATE_FILE, 'utf-8');
        state = JSON.parse(stateData);
        log('Previous state loaded.');
    } catch (err) {
        log('No previous state found. Running initial scrape.');
    }

    // Prepare directories
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.rm(COMPILED_DIR, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(COMPILED_DIR, { recursive: true });

    const lessonsMap = await getCurriculumTree();
    log(`Found ${lessonsMap.length} targeted markdown lessons.`);

    const newState = {};
    const compiledContent = {}; 
    const diff = { added: [], updated: [], removed: [] };

    // Check for removed lessons
    const currentPaths = new Set(lessonsMap.map(l => l.github_path));
    for (const oldPath of Object.keys(state)) {
        if (!currentPaths.has(oldPath)) {
            diff.removed.push(state[oldPath]);
        }
    }

    for (let i = 0; i < lessonsMap.length; i++) {
        const lesson = lessonsMap[i];
        const rawUrl = `${REPO_CURRICULUM_RAW}${lesson.github_path}`;
        
        let mdText = await fetchWithRetry(rawUrl).catch(e => null);
        if (!mdText) continue;

        const titleMatch = mdText.match(/^#\s+(.+)/m);
        lesson.title = titleMatch ? titleMatch[1].trim() : lesson.github_path.split('/').pop().replace('.md', '');
        lesson.slug = lesson.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');

        const currentHash = hashString(mdText);
        const oldState = state[lesson.github_path];
        let hasChanged = false;
        let lessonCompiled = '';

        // Diffing Logic
        if (!oldState) {
            diff.added.push(lesson);
            hasChanged = true;
        } else if (oldState.hash !== currentHash) {
            diff.updated.push(lesson);
            hasChanged = true;
        }

        const cacheFilePath = path.join(CACHE_DIR, `${lesson.slug}.md`);

        // Attempt to load from cache if markdown hash hasn't changed
        if (!hasChanged) {
            try {
                lessonCompiled = await fs.readFile(cacheFilePath, 'utf-8');
                log(`[${i+1}/${lessonsMap.length}] Cached: ${lesson.course} -> ${lesson.title}`);
            } catch (err) {
                // If the cache file was manually deleted, force a recompile
                hasChanged = true; 
            }
        }

        // Fetch and compile if new, updated, or cache is missing
        if (hasChanged) {
            log(`[${i+1}/${lessonsMap.length}] Compiling/Fetching: ${lesson.course} -> ${lesson.title}`);
            const externalLinks = extractExternalLinks(mdText);
            lessonCompiled = `\n\n# Lesson: ${lesson.title}\nOriginal URL: https://www.theodinproject.com/lessons/${lesson.slug}\n\n${mdText}\n\n`;

            if (externalLinks.length > 0) {
                lessonCompiled += `\n\n## External Resources Extracted\n`;
                for (const link of externalLinks) {
                    const extMd = await fetchJinaMarkdown(link.url);
                    lessonCompiled += `\n### External: ${link.title}\nSource: ${link.url}\n\n${extMd}\n\n---\n`;
                    if (!isYouTube(link.url)) await sleep(500); 
                }
            }
            // Save to local cache
            await fs.writeFile(cacheFilePath, lessonCompiled);
        }

        const compileKey = `${lesson.course}`;
        if (!compiledContent[compileKey]) compiledContent[compileKey] = '';
        compiledContent[compileKey] += lessonCompiled;

        // WRITE TO FILE IMMEDIATELY
        const filePath = path.join(COMPILED_DIR, `${compileKey}.md`);
        await fs.writeFile(filePath, compiledContent[compileKey]);

        newState[lesson.github_path] = {
            title: lesson.title,
            slug: lesson.slug,
            course: lesson.course,
            hash: currentHash
        };
        
        await fs.writeFile(STATE_FILE, JSON.stringify(newState, null, 2));
    }

    // Generate Diff Report
    log('Generating Diff Report...');
    let diffReport = `# Odin Project Curriculum Changes\nGenerated on: ${new Date().toISOString()}\n\n`;
    
    diffReport += `## Added Lessons (${diff.added.length})\n`;
    diff.added.forEach(l => diffReport += `- [${l.title}](https://www.theodinproject.com/lessons/${l.slug})\n`);
    
    diffReport += `\n## Updated Lessons (${diff.updated.length})\n`;
    diff.updated.forEach(l => diffReport += `- [${l.title}](https://www.theodinproject.com/lessons/${l.slug})\n`);
    
    diffReport += `\n## Removed Lessons (${diff.removed.length})\n`;
    diff.removed.forEach(l => diffReport += `- ${l.title} (Formerly at /${l.slug})\n`);

    await fs.writeFile(DIFF_FILE, diffReport);

    log('Done! All targeted files compiled.');
}

run().catch(err => console.error('Fatal Error:', err));
