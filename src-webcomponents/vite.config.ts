import react from '@vitejs/plugin-react';
import { checkManifest, getReactImportPath, REACT_SPECIFIERS, type WebComponentText } from '@iobroker/web-components';
import { readFileSync } from 'node:fs';
import type { Plugin, UserConfig } from 'vite';

// with the extension: Vite may load its config natively, without a bundler that would add it
import { COMPONENT_NAMES, getManifestFile, getModuleFile, getModulePath, type ComponentName } from './src/constants.ts';
import { ADMIN_WORDS } from './src/adminWords.ts';
import { buildManifests } from './src/manifest.ts';

/**
 * The web components `<iob-assistant-chat>` and `<iob-assistant-satellites>`: one ES module each,
 * `admin/webcomponents/assistant-chat.js` and `assistant-satellites.js`, and its manifest `<name>.json` next to it
 * (`common.webComponents`). Every host - vis-2, devices, Aura, admin - reads them from `/adapter/assistant/webcomponents/`.
 * No module federation: the host shares nothing but the socket.
 *
 * One build per component - `vite build --mode assistant-chat`, `vite build --mode assistant-satellites`
 * (`npm run build`, from the root `npm run build:wc`): a host imports exactly one URL per component, so each module
 * is one file, with the shared code compiled into both. Like `src-admin`, the build writes straight into `admin/`.
 *
 * React is not bundled: the four React imports point at `lib/esm/react-19.js`, which web and admin serve
 * beside `adapter/`. The path is relative to the module, so a path prefix of a reverse proxy stays.
 */

const LANGUAGES = ['en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'];

/** The words of the chat and the satellites tab of the instance settings */
const ADMIN_I18N = '../src-admin/src/i18n';
const ADMIN_PREFIX = 'custom_assistant_';

/** Where both builds write: the admin folder of the adapter, served as `/adapter/assistant/` */
const OUT_DIR = '../admin/webcomponents';

/** The module of each component */
const ENTRIES: Record<ComponentName, string> = {
    'assistant-chat': './src/AssistantChat.tsx',
    'assistant-satellites': './src/VoiceSatellites.tsx',
};

const dictionaries = Object.fromEntries(
    LANGUAGES.map(lang => [
        lang,
        JSON.parse(readFileSync(new URL(`${ADMIN_I18N}/${lang}.json`, import.meta.url), 'utf8')) as Record<
            string,
            string
        >,
    ]),
);

/**
 * A word of the instance settings in every language - the build fails if one is missing
 *
 * @param key the word without the prefix `custom_assistant_`
 */
function adminWord(key: string): WebComponentText {
    const text: Record<string, string> = {};
    for (const lang of LANGUAGES) {
        const word = dictionaries[lang][`${ADMIN_PREFIX}${key}`];
        if (!word) {
            throw new Error(`${ADMIN_I18N}/${lang}.json has no "${ADMIN_PREFIX}${key}"`);
        }
        text[lang] = word;
    }
    return text as WebComponentText;
}

/**
 * The words of the instance settings one component shows (`src/adminWords.ts`), for `createWords()` in
 * `src/i18n.ts`: language -> word -> text
 *
 * @param name the component
 */
function pickAdminWords(name: ComponentName): Record<string, Record<string, string>> {
    const picked: Record<string, Record<string, string>> = Object.fromEntries(LANGUAGES.map(lang => [lang, {}]));
    for (const key of ADMIN_WORDS[name]) {
        const text = adminWord(key) as Record<string, string>;
        for (const lang of LANGUAGES) {
            picked[lang][key] = text[lang];
        }
    }
    return picked;
}

/** Writes `<name>.json` next to the module, checked like a host checks it */
function manifestFile(name: ComponentName): Plugin {
    return {
        name: 'assistant-web-component-manifest',
        generateBundle() {
            const manifest = buildManifests(adminWord)[name];
            const problem = checkManifest(manifest);
            if (problem) {
                this.error(`${getManifestFile(name)}: ${problem}`);
            }
            if (manifest.module !== getModuleFile(name)) {
                this.error(`${getManifestFile(name)}: "module" must be "${getModuleFile(name)}"`);
            }
            this.emitFile({
                type: 'asset',
                fileName: getManifestFile(name),
                source: `${JSON.stringify(manifest, null, 4)}\n`,
            });
        },
    };
}

export default ({ mode }: { mode: string }): UserConfig => {
    const name = COMPONENT_NAMES.find(component => component === mode);
    if (!name) {
        throw new Error(`Build one component at a time: vite build --mode <${COMPONENT_NAMES.join('|')}>`);
    }
    const reactImport = getReactImportPath(getModulePath(name));

    return {
        plugins: [react(), manifestFile(name)],
        define: {
            'process.env.NODE_ENV': JSON.stringify('production'),
            __ASSISTANT_ADMIN_WORDS__: JSON.stringify(pickAdminWords(name)),
        },
        build: {
            target: 'es2022',
            outDir: OUT_DIR,
            // the builds of all components write into the same folder: only the first one empties it
            emptyOutDir: name === COMPONENT_NAMES[0],
            lib: {
                entry: ENTRIES[name],
                formats: ['es'],
                fileName: (): string => getModuleFile(name),
            },
            rollupOptions: {
                external: [...REACT_SPECIFIERS],
                output: {
                    paths: Object.fromEntries(REACT_SPECIFIERS.map(specifier => [specifier, reactImport])),
                    // one file: a host imports exactly one URL
                    codeSplitting: false,
                    // library mode keeps whitespace for the bundler of a consumer; this module is loaded as it is
                    minify: true,
                },
            },
        },
    };
};
