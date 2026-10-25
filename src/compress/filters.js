import { hide, collapseSection, marker } from './generic.js';

// Each filter knows one noisy tool. `cmd` matches the command line (also used
// to decide which commands the PreToolUse hook pipes through lore);
// `sniff` matches the output itself when the command is a wrapper (make test…).
// Rule of thumb: hide what passed or progressed, keep what failed or summarizes.

const PM = '(?:npm|pnpm|yarn|bun)';

const XCODE_STEP = new RegExp(
  '^(' +
    [
      'CompileSwift\\w*', 'SwiftCompile', 'SwiftDriver\\w*', 'SwiftEmitModule', 'SwiftMergeGeneratedHeaders',
      'SwiftGeneratePch', 'SwiftExplicitDependency\\w*', 'EmitSwiftModule', 'MergeSwiftModule', 'CompileC',
      'CompileAssetCatalog\\w*', 'CompileStoryboard', 'CompileXIB', 'LinkStoryboards', 'Ld', 'Libtool',
      'CpResource', 'CpHeader', 'CopySwiftLibs', 'Copy', 'CopyPlistFile', 'CopyStringsFile', 'CopyPNGFile',
      'ProcessInfoPlistFile', 'ProcessProductPackaging\\w*', 'ProcessPCH', 'ProcessXCFramework', 'CodeSign',
      'Touch', 'PhaseScriptExecution', 'CreateBuildDirectory', 'CreateBuildDescription', 'WriteAuxiliaryFile',
      'MkDir', 'SymLink', 'GenerateDSYMFile', 'GenerateAssetSymbols', 'GenerateTAPI', 'LinkAssetCatalog',
      'RegisterExecutionPolicyException', 'RegisterWithLaunchServices', 'Validate\\w*', 'PrecompileModule',
      'ScanDependencies', 'ExtractAppIntentsMetadata', 'AppIntentsSSUTraining', 'ComputeTargetDependencyGraph',
      'ComputePackagePrebuildTargetDependencyGraph', 'ClangStatCache', 'GatherProvisioningInputs',
      'CreateUniversalBinary', 'ConstructStubExecutorLinkFileList', 'Strip', 'SetOwnerAndGroup', 'SetMode',
      'ProcessAssetPack', 'Prepare packages', 'Building library', 'Planning', 'ResolvePackageGraph',
    ].join('|') +
    ')\\b',
);

function groupTsErrors(lines) {
  const ERR = /error (TS\d+):/;
  if (lines.filter((l) => ERR.test(l)).length <= 25) return lines;
  const seen = new Map();
  const hidden = new Map();
  const out = [];
  let skipping = false;
  for (const line of lines) {
    const m = line.match(ERR);
    if (m) {
      const n = (seen.get(m[1]) || 0) + 1;
      seen.set(m[1], n);
      skipping = n > 3;
      if (skipping) {
        hidden.set(m[1], (hidden.get(m[1]) || 0) + 1);
        continue;
      }
    } else if (skipping && /^\s/.test(line) && line.trim()) {
      continue; // continuation line of a hidden error
    } else {
      skipping = false;
    }
    out.push(line);
  }
  for (const [code, n] of hidden) out.push(marker(`${n} more ${code} errors hidden`));
  return out;
}

function groupEslint(lines) {
  const PROBLEM = /^\s+\d+:\d+\s+(error|warning)\s+.*?\s{2,}([@\w/-]+)\s*$/;
  if (lines.filter((l) => PROBLEM.test(l)).length <= 30) return lines;
  const seen = new Map();
  const hidden = new Map();
  const kept = [];
  for (const line of lines) {
    const m = line.match(PROBLEM);
    if (m) {
      const n = (seen.get(m[2]) || 0) + 1;
      seen.set(m[2], n);
      if (n > 4) {
        hidden.set(m[2], (hidden.get(m[2]) || 0) + 1);
        continue;
      }
    }
    kept.push(line);
  }
  // Drop file headers whose problems were all hidden.
  const isFile = (l) => /^\S.*\.\w+$/.test(l) && !l.startsWith('✖');
  const out = kept.filter((l, i) => !isFile(l) || PROBLEM.test(kept[i + 1] || ''));
  const summary = [...hidden].sort((a, b) => b[1] - a[1]).map(([rule, n]) => `${rule} ×${n}`);
  if (summary.length) out.push(marker(`more problems hidden: ${summary.join(', ')}`));
  return out;
}

// Hide passing tests, and the `describe` headers of verbose jest/mocha output
// whose whole block passed. A header only goes if everything indented under it
// went too, so unrelated indented output (lint problems, diffs) is safe.
function hidePassingTests(lines) {
  const PASSED = /^\s*[✓√✔]\s/;
  const indent = (s) => s.match(/^\s*/)[0].length;
  const gone = lines.map((l) => PASSED.test(l));
  for (let i = lines.length - 1; i >= 0; i--) {
    if (gone[i] || !/^\s{2,}[^\s●✕×]/.test(lines[i])) continue;
    let any = false;
    let all = true;
    for (let j = i + 1; j < lines.length && (!lines[j].trim() || indent(lines[j]) > indent(lines[i])); j++) {
      if (!lines[j].trim()) continue;
      any = true;
      if (!gone[j]) {
        all = false;
        break;
      }
    }
    gone[i] = any && all;
  }
  const passed = lines.filter((l) => PASSED.test(l)).length;
  if (passed <= 2) return lines;
  const out = [];
  let noted = false;
  lines.forEach((line, i) => {
    if (!gone[i]) out.push(line);
    else if (!noted) noted = out.push(marker(`${passed} passing tests hidden`));
  });
  return out;
}

export const FILTERS = [
  {
    name: 'xcodebuild',
    cmd: /\b(xcodebuild|swift\s+(build|test)|fastlane)\b/,
    sniff: /^(CompileSwift|SwiftCompile|SwiftDriver|CodeSign|Ld) /m,
    apply(lines) {
      lines = hide(lines, XCODE_STEP, 'build step lines');
      lines = hide(lines, /^\s{4}(cd |export |builtin-|\/Applications\/Xcode|\/usr\/bin\/|\/bin\/|write-file |\/Library\/Developer)/, 'build command lines');
      // (SwiftPM separates "[23 / 96]" with thin spaces.)
      lines = hide(lines, /^\[\d+\s?\/\s?\d+\]|^\[(Pre-planning|Planning)\b/, 'build progress lines');
      lines = hide(
        lines,
        /^(Create build (directory|description)|Discovering version info|Compute target dependency graph|Gather provisioning inputs|Build description (signature|path)|info: (Target|➜|Building targets))/,
        'build setup lines',
      );
      lines = hide(lines, /^Test Case '.*' (passed|started)|^\s*[✔✓] Test .* passed|^Test Suite '.*' (started|passed)/, 'passing test lines');
      return hide(lines, /^note: (Building targets|Using |Target dependency graph|Run script build phase)/, 'build notes');
    },
  },
  {
    name: 'js-install',
    cmd: new RegExp(`\\b${PM}\\s+(i|install|add|ci|update|upgrade)\\b|^\\s*(yarn|pnpm i)\\s*$|\\bpod\\s+install\\b`),
    apply(lines) {
      lines = hide(lines, /\bdeprecated\b/i, 'deprecation warnings');
      lines = hide(lines, /^npm (notice|http|timing|sill|verb)\b|^(Progress|Packages): |^\s*[+-]{3,}|^(Resolving|Fetching|Downloading|Linking|Building fresh)|^\[\d\/\d\]/, 'progress lines');
      lines = hide(lines, /^\s*[+-] [@\w]/, 'package lines');
      return hide(lines, /looking for funding|npm fund\b|^Run `npm audit/, 'funding notices', 0);
    },
  },
  {
    name: 'py-install',
    cmd: /\b(pip3?|uv\s+pip|poetry|pipenv)\s+(install|add|sync|lock)\b|\buv\s+(sync|add|lock)\b/,
    apply(lines) {
      return hide(
        lines,
        /^\s*(Requirement already satisfied|Collecting|Downloading|Using cached|Obtaining|Preparing metadata|Building wheels?|Created wheel|Stored in directory|Installing build dependencies|Getting requirements|Installing collected|Resolved \d+|Prepared \d+|Audited \d+|Downloaded \d+|Uninstalling|Attempting uninstall|Found existing installation|Successfully uninstalled)/,
        'progress lines',
      );
    },
  },
  {
    name: 'js-test',
    cmd: new RegExp(`\\b(jest|vitest|mocha|ava|playwright\\s+test|bun\\s+test|${PM}(\\s+run)?\\s+test(:\\S+)?)\\b`),
    sniff: /^\s*(PASS|FAIL)\s+\S+\.[cm]?[tj]sx?\b|^\s*Test Files\s+\d+|^Tests:\s+\d+/m,
    apply(lines) {
      lines = hide(lines, /^\s*PASS\s/, 'passing suites');
      lines = hidePassingTests(lines);
      // Coverage tables: keep the header and the "All files" row.
      return hide(lines, /^\s*(?!All files)[^|]*\|\s*[\d.]+\s*\|\s*[\d.]+\s*\|/, 'coverage rows');
    },
  },
  {
    name: 'pytest',
    cmd: /\b(pytest|py\.test|tox|nox)\b|python3?\s+-m\s+(pytest|unittest)/,
    sniff: /^=+ test session starts =+$/m,
    apply(lines) {
      lines = hide(lines, /^\S+\.py\s+[.sx]+\s*(\[\s*\d+%\])?$/, 'passing test-file progress lines');
      lines = hide(lines, /::\S+ PASSED\b/, 'passing tests');
      return collapseSection(lines, /^=+ warnings summary =+$/, 12, 'warning lines');
    },
  },
  {
    name: 'cargo',
    cmd: /\bcargo\s+(build|test|check|run|clippy|install|b|t|c|r|nextest)\b/,
    sniff: /^\s+Compiling \S+ v\d/m,
    apply(lines) {
      lines = hide(lines, /^\s*(Compiling|Checking|Downloaded|Downloading|Fresh|Updating|Locking|Adding|Blocking|Documenting|Installing|Unpacking)\s/, 'build progress lines');
      return hide(lines, /^test \S+ \.\.\. ok$|^\s+PASS \[/, 'passing tests');
    },
  },
  {
    name: 'go',
    cmd: /\bgo\s+(test|build|vet|mod|get|install|run|generate)\b/,
    sniff: /^(=== RUN|--- (PASS|FAIL):)/m,
    apply(lines) {
      lines = hide(lines, /^\s*=== (RUN|PAUSE|CONT|NAME)\s/, 'test start lines');
      lines = hide(lines, /^\s*--- PASS:/, 'passing tests');
      lines = hide(lines, /^ok\s+\S+/, 'passing packages');
      return hide(lines, /^go: (downloading|finding|extracting|added|upgraded)\b/, 'module download lines');
    },
  },
  {
    name: 'tsc',
    cmd: /\b(tsc|vue-tsc|svelte-check)\b|\b(type-?check|typecheck)\b/,
    sniff: /error TS\d+:/,
    apply: groupTsErrors,
  },
  {
    name: 'eslint',
    cmd: new RegExp(`\\b(eslint|next\\s+lint|${PM}(\\s+run)?\\s+lint(:\\S+)?)\\b`),
    apply: groupEslint,
  },
  {
    name: 'js-build',
    cmd: new RegExp(`\\b(${PM}(\\s+run)?\\s+build(:\\S+)?|vite\\s+build|next\\s+build|webpack|tsup|rollup|esbuild|turbo\\s+(run\\s+)?build|expo\\s+export)\\b`),
    apply(lines) {
      lines = hide(lines, /^\s*(dist|build|out|\.next)\/\S+\s+[\d.,]+\s*[kKmM]i?B\b/, 'asset size lines');
      lines = hide(lines, /^\s*[├└┌│]\s+[○●ƒλ◐]?\s*\//, 'route lines');
      return hide(lines, /^(transforming|rendering chunks|computing gzip size)/, 'progress lines');
    },
  },
  {
    name: 'docker',
    cmd: /\bdocker(-compose)?\s+(build|pull|push|buildx|compose\s+(build|pull|up))\b/,
    sniff: /^#\d+ \[/m,
    apply(lines) {
      lines = hide(lines, /^#\d+ (sha256:|extracting|resolve |transferring|DONE|CACHED|\[internal\])/, 'layer progress lines');
      return hide(lines, /^[0-9a-f]{12}: (Pulling|Waiting|Downloading|Verifying|Download complete|Extracting|Pull complete|Already exists|Pushing|Pushed|Layer already exists|Preparing)/, 'layer progress lines');
    },
  },
  {
    name: 'jvm',
    cmd: /(^|[\s/])(gradlew?|mvnw?)\b/,
    apply(lines) {
      lines = hide(lines, /^\[INFO\] (Download(ing|ed) from|-+$|\s*$)|^Download(ing)? https?:/, 'download lines');
      lines = hide(lines, /^> Task .*(UP-TO-DATE|NO-SOURCE|FROM-CACHE|SKIPPED)$/, 'skipped tasks');
      return hide(lines, /<[-=]+>\s*\d+%/, 'progress lines');
    },
  },
  {
    name: 'make',
    cmd: /\b(make|ninja|cmake\s+--build)\b/,
    apply(lines) {
      return hide(lines, /^\[\s*\d+%\] (Building|Linking|Built target|Scanning)|^\[\d+\/\d+\] /, 'build progress lines');
    },
  },
  {
    name: 'git-transfer',
    cmd: /\bgit\s+(clone|fetch|pull|push)\b/,
    apply(lines) {
      return hide(lines, /^(remote: )?(Counting|Compressing|Receiving|Resolving|Enumerating|Total \d|Writing|Delta compression|Unpacking)/, 'transfer progress lines');
    },
  },
  {
    name: 'brew',
    cmd: /\bbrew\s+(install|upgrade|update|reinstall)\b/,
    apply(lines) {
      return hide(lines, /^==> (Fetching|Downloading|Pouring)|^#+\s*\d+(\.\d+)?%|^Already downloaded|^Downloaded/, 'download lines');
    },
  },
];

// The command's own filter, plus any whose output we recognize: `make test`
// that runs pytest gets both the make and the pytest treatment.
export function pickFilters(command, lines) {
  const head = lines.slice(0, 300).join('\n');
  const byCmd = FILTERS.find((f) => f.cmd.test(command));
  const bySniff = FILTERS.filter((f) => f !== byCmd && f.sniff?.test(head));
  return byCmd ? [byCmd, ...bySniff] : bySniff;
}

export const isNoisyCommand = (command) => FILTERS.some((f) => f.cmd.test(command));

// Commands whose output *is* the content the agent asked for. Trimming a
// `cat` or `git diff` would hand the agent a file that doesn't exist.
const INSPECT = new Set([
  'cat', 'sed', 'head', 'tail', 'nl', 'less', 'more', 'bat', 'grep', 'egrep', 'rg', 'ag', 'ack', 'git', 'diff',
  'jq', 'yq', 'awk', 'find', 'fd', 'ls', 'tree', 'wc', 'file', 'stat', 'sqlite3', 'psql', 'mysql', 'curl', 'wget',
  'xxd', 'hexdump', 'od', 'strings', 'plutil', 'defaults', 'env', 'printenv', 'which', 'man', 'cut', 'sort', 'uniq',
]);

export function isInspectCommand(command) {
  const first = command
    .split(/&&|;|\|\||\||\n/)
    .map((s) => s.trim())
    .find((s) => s && !/^(cd|export|set)\b/.test(s));
  const [word = '', arg] = (first || '').split(/\s+/).filter((w) => !/^\w+=/.test(w) && w !== 'sudo');
  const bin = word.replace(/^.*\//, '');
  // Inline scripts print whatever they were written to print.
  if (/^(node|bun|deno|python3?|ruby|perl)$/.test(bin) && /^-(e|p|c)$/.test(arg || '')) return true;
  if (bin === 'git') return !/^(clone|fetch|pull|push)$/.test(arg || '');
  return INSPECT.has(bin) || bin === 'echo' || bin === 'printf';
}
