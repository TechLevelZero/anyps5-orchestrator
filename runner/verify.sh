#!/bin/bash
set -uo pipefail
export LC_ALL=C
JOB=$1
OWNER=$2
BRANCH=$3
: "${ENGINE:?}" "${REPO_URL:?}" "${WORK:?}"
IMAGE=${IMAGE:-anyps5-orch-build:1}
JOBS=${JOBS:-$(nproc)}
TEST_JOBS=${TEST_JOBS:-6}
ROOT=$WORK/jobs/$JOB
OUT=$ROOT/out
SECCOMP=$WORK/runner/seccomp-uffd.json
mkdir -p "$OUT" "$WORK/cache"
step() { echo "$(date -Is) $*" | tee -a "$OUT/progress.log"; }
fail() { step "FAILED: $*"; printf '{"status":"failed","reason":"%s"}\n' "$*" > "$OUT/result.json"; exit 1; }
[[ "$JOB" =~ ^[A-Za-z0-9-]+$ ]] || fail "bad job id"
[[ "$OWNER" =~ ^[A-Za-z0-9-]+$ ]] || fail "bad owner"
[[ "$BRANCH" =~ ^[A-Za-z0-9._/-]+$ ]] && [[ "$BRANCH" != *..* ]] || fail "bad branch"
[[ "$REPO_URL" =~ ^https://github\.com/[A-Za-z0-9-]+/[A-Za-z0-9._-]+(\.git)?$ ]] || fail "bad repository URL"
UPSTREAM_NAME=$(basename "$REPO_URL" .git)

if [ "$ENGINE" = docker ]; then
  ID=(-u "$(id -u):$(id -g)")
else
  ID=(--security-opt label=disable --userns=keep-id)
fi
gpu_args() {
  case "$1" in
    nvidia:*) if [ "$ENGINE" = docker ]; then echo "--gpus device=${1#nvidia:}"; else echo "--device nvidia.com/gpu=${1#nvidia:}"; fi ;;
    dri:*) if [ "$ENGINE" = docker ]; then a="--device /dev/dri"; for g in $(stat -c %g /dev/dri/* 2>/dev/null | sort -u); do a="$a --group-add $g"; done; echo "$a"; else echo "--device /dev/dri --group-add keep-groups"; fi ;;
    *) echo "" ;;
  esac
}
trusted() { $ENGINE run --rm "${ID[@]}" -e HOME=/tmp -v "$WORK:/work" "$IMAGE" bash -c "git config --global --add safe.directory '*'; $1"; }
sandbox() {
  local name=$1 tree=$2 gpu=$3 command=$4
  $ENGINE run --rm --network none --name "orch-$JOB-$name" $(gpu_args "$gpu") --security-opt "seccomp=$SECCOMP" "${ID[@]}" -e HOME=/tmp \
    -v "$ROOT/$tree:/work/main" -v "$ROOT/build-$tree:/work/build-main" -v "$ROOT/srcgit:/work/src/.git:ro" -v "$OUT:/out" "$IMAGE" bash -c "$command"
}
copy() { cp -a --reflink=auto "$1" "$2"; }
cleanup() { [ "${KEEP_TREES:-0}" = 1 ] || rm -rf "$ROOT/main" "$ROOT/build-main" "$ROOT/dev" "$ROOT/build-dev" "$ROOT/srcgit"; }
trap cleanup EXIT
trap "exit 143" TERM INT

if ! $ENGINE image inspect "$IMAGE" >/dev/null 2>&1; then
  step "building the $IMAGE image (first run only)"
  $ENGINE build -t "$IMAGE" "$WORK/runner/image" > "$WORK/cache/image-build.log" 2>&1 || fail "image build (see $WORK/cache/image-build.log)"
fi

step "fetching main and $OWNER/$BRANCH"
trusted "set -e; [ -d /work/src/.git ] || git clone -q --no-checkout $REPO_URL /work/src; cd /work/src
  git fetch -q origin main; git fetch -q https://github.com/$OWNER/$UPSTREAM_NAME.git '+refs/heads/$BRANCH:refs/orch/$JOB'
  MAIN=\$(git rev-parse origin/main); HEAD=\$(git rev-parse refs/orch/$JOB)
  mkdir -p /work/jobs/$JOB/out; echo \$MAIN > /work/jobs/$JOB/out/main.sha; echo \$HEAD > /work/jobs/$JOB/out/head.sha
  if TREE=\$(git merge-tree --write-tree --no-messages \$MAIN \$HEAD); then
    git diff --binary \$MAIN \$TREE > /work/jobs/$JOB/out/change.patch; git diff --name-only \$MAIN \$TREE > /work/jobs/$JOB/out/changed.txt
  else echo conflicts > /work/jobs/$JOB/out/conflicts; fi" || fail "fetch"
[ -e "$OUT/conflicts" ] && fail "the branch conflicts with main; it needs a rebase"
MAIN=$(cat "$OUT/main.sha"); HEAD=$(cat "$OUT/head.sha")
step "main ${MAIN:0:10}, branch ${HEAD:0:10}, $(wc -l < "$OUT/changed.txt") files changed"

exec 9> "$WORK/cache/main.lock"
flock 9
if [ "$(cat "$WORK/build-main/BUILT" 2>/dev/null)" != "$MAIN" ]; then
  step "building main ${MAIN:0:10} (trusted; cached for later jobs)"
  trusted "set -e; export CCACHE_DIR=/work/cache/ccache CCACHE_MAXSIZE=30G; cd /work/src; [ -e /work/main/.git ] || git worktree add -q --detach /work/main $MAIN
    cd /work/main; git checkout -q --detach $MAIN; git submodule update --init --recursive -j8 >/dev/null 2>&1
    cmake -S /work/main -B /work/build-main -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_COMPILER=gcc -DCMAKE_CXX_COMPILER=g++ -DBUILD_TESTING=ON -DANYPS5_ENABLE_SPIRV_TOOLS=ON -DCMAKE_C_COMPILER_LAUNCHER=ccache -DCMAKE_CXX_COMPILER_LAUNCHER=ccache > /work/cache/main-configure.log 2>&1
    cmake --build /work/build-main --parallel $JOBS > /work/cache/main-build.log 2>&1 && cmake --build /work/build-main --target libs --parallel $JOBS >> /work/cache/main-build.log 2>&1
    echo $MAIN > /work/build-main/BUILT" || fail "main build (see $WORK/cache/main-build.log)"
fi
probe=$WORK/cache/reflink-probe; echo x > "$probe.a"
if cp --reflink=always "$probe.a" "$probe.b" 2>/dev/null; then REFLINK=1; else REFLINK=0; fi; rm -f "$probe.a" "$probe.b"
if [ "$REFLINK" = 0 ]; then
  NEED=$(( $(du -sk "$WORK/main" "$WORK/build-main" "$WORK/src/.git" 2>/dev/null | awk '{s+=$1} END {print s}') * 2 / 1024 / 1024 + 5 ))
  FREE=$(( $(df -Pk "$WORK" | awk 'NR==2 {print $4}') / 1024 / 1024 ))
  [ "$FREE" -ge "$NEED" ] || fail "not enough disk space: the sandbox needs about $NEED GB (this filesystem has no reflink copies) and $FREE GB are free in $WORK"
fi
step "making the sandbox"
rm -rf "$ROOT/main" "$ROOT/build-main" "$ROOT/dev" "$ROOT/build-dev" "$ROOT/srcgit"
copy "$WORK/main" "$ROOT/main" && copy "$WORK/build-main" "$ROOT/build-main" && copy "$WORK/main" "$ROOT/dev" && copy "$WORK/build-main" "$ROOT/build-dev" && copy "$WORK/src/.git" "$ROOT/srcgit" || fail "sandbox copy"
flock -u 9
$ENGINE run --rm --network none "${ID[@]}" -e HOME=/tmp -v "$ROOT/dev:/work/main" -v "$ROOT/srcgit:/work/src/.git:ro" -v "$OUT:/out:ro" "$IMAGE" \
  bash -c "git config --global --add safe.directory '*'; cd /work/main && git apply --binary /out/change.patch" || fail "the change does not apply"

step "selecting tests"
$ENGINE run --rm "${ID[@]}" -e HOME=/tmp -v "$ROOT/main:/work/main" -v "$ROOT/build-main:/work/build-main" -v "$OUT:/out" "$IMAGE" \
  bash -c "cd /work/main && python3 tools/select_tests.py dump /work/build-main /tmp/graph.json > /dev/null && python3 tools/select_tests.py explain /tmp/graph.json /out/changed.txt > /out/selection.json" || fail "test selection"

step "building the branch in the sandbox (no network)"
sandbox build dev none "export CCACHE_DISABLE=1; cmake --build /work/build-main --parallel $JOBS > /out/dev-build.log 2>&1 && cmake --build /work/build-main --target libs --parallel $JOBS >> /out/dev-build.log 2>&1" || fail "the branch does not build (see dev-build.log)"

python3 -c "import json;d=json.load(open('$OUT/selection.json'));print('\n'.join(sorted(set(d.get('tests') or []))))" > "$OUT/tests.txt"
sandbox list dev none "ctest --test-dir /work/build-main -N | sed -nE 's/^ *Test +#[0-9]+: //p' | sort > /out/dev.alltests"
$ENGINE run --rm "${ID[@]}" -v "$ROOT/main:/work/main" -v "$ROOT/build-main:/work/build-main" "$IMAGE" bash -c "ctest --test-dir /work/build-main -N | sed -nE 's/^ *Test +#[0-9]+: //p' | sort" > "$OUT/main.alltests"
comm -13 "$OUT/main.alltests" "$OUT/dev.alltests" > "$OUT/new-tests.txt"
sort -u -o "$OUT/tests.txt" "$OUT/tests.txt" "$OUT/new-tests.txt"
comm -12 "$OUT/tests.txt" "$OUT/main.alltests" > "$OUT/tests-main.txt"

failed() { grep -E "^\s*[0-9]+ - .*\((Failed|Timeout|SEGFAULT|Subprocess aborted|Exception|OTHER_FAULT|Child aborted|ILLEGAL)" "$1" | sed -E "s/^\s*[0-9]+ - //; s/ \(.*//" | sort -u; }
VULKAN="export ANYPS5_REQUIRE_VULKAN=1 ANYPS5_NO_SHADER_CACHE=1 VK_INSTANCE_LAYERS=VK_LAYER_KHRONOS_validation"
while IFS='|' read -r GPU_ID GPU_SPEC GPU_NAME; do
  [ -n "$GPU_ID" ] || continue
  G=$OUT/gpu-$GPU_ID; mkdir -p "$G"
  PICK=""; [ -n "$GPU_NAME" ] && PICK="export ANYPS5_GPU='$GPU_NAME';"
  step "[$GPU_ID] running $(wc -l < "$OUT/tests-main.txt") tests on main"
  $ENGINE run --rm --name "orch-$JOB-main-$GPU_ID" $(gpu_args "$GPU_SPEC") --security-opt "seccomp=$SECCOMP" "${ID[@]}" -e HOME=/tmp \
    -v "$ROOT/main:/work/main" -v "$ROOT/build-main:/work/build-main" -v "$OUT:/out" "$IMAGE" \
    bash -c "$VULKAN; $PICK ctest --test-dir /work/build-main --tests-from-file /out/tests-main.txt -V -j$TEST_JOBS --timeout 180 > /out/gpu-$GPU_ID/main.log 2>&1; vulkaninfo --summary 2>/dev/null > /out/gpu-$GPU_ID/vulkaninfo.txt"
  step "[$GPU_ID] running $(wc -l < "$OUT/tests.txt") tests on the branch (sandbox)"
  sandbox "dev-$GPU_ID" dev "$GPU_SPEC" "$VULKAN; $PICK ctest --test-dir /work/build-main --tests-from-file /out/tests.txt -V -j$TEST_JOBS --timeout 180 > /out/gpu-$GPU_ID/dev.log 2>&1"
  failed "$G/main.log" > "$G/main.failed"; failed "$G/dev.log" > "$G/dev.failed"
  ONLY=$(comm -13 "$G/main.failed" "$G/dev.failed" | grep -vxFf "$OUT/new-tests.txt" | paste -sd'|' -)
  if [ -n "$ONLY" ]; then
    step "[$GPU_ID] rechecking branch-only failures one at a time"
    for i in 1 2 3; do
      $ENGINE run --rm $(gpu_args "$GPU_SPEC") --security-opt "seccomp=$SECCOMP" "${ID[@]}" -e HOME=/tmp -v "$ROOT/main:/work/main" -v "$ROOT/build-main:/work/build-main" "$IMAGE" \
        bash -c "$VULKAN; $PICK ctest --test-dir /work/build-main -R '^($ONLY)\$' -j1 --timeout 300" > "$G/recheck-main-$i.log" 2>&1
      sandbox "recheck-$GPU_ID-$i" dev "$GPU_SPEC" "$VULKAN; $PICK ctest --test-dir /work/build-main -R '^($ONLY)\$' -j1 --timeout 300 > /out/gpu-$GPU_ID/recheck-dev-$i.log 2>&1"
    done
  fi
  python3 - "$OUT" "$GPU_ID" "$GPU_NAME" <<'P'
import glob, json, re, sys
out, gid, name = sys.argv[1:4]
g = f"{out}/gpu-{gid}"
def read(path):
    try: return open(path).read()
    except OSError: return ""
def lines(path): return [line for line in read(path).splitlines() if line]
def summary(log):
    match = re.findall(r"(\d+)% tests passed, (\d+) tests failed out of (\d+)", log)
    return {"failed": int(match[-1][1]), "total": int(match[-1][2])} if match else None
def vuids(log): return sorted(set(re.findall(r"VUID-[A-Za-z0-9_-]+", log)))
main_log, dev_log, info = read(f"{g}/main.log"), read(f"{g}/dev.log"), read(f"{g}/vulkaninfo.txt")
main_failed, dev_failed, new = set(lines(f"{g}/main.failed")), set(lines(f"{g}/dev.failed")), set(lines(f"{out}/new-tests.txt"))
recheck = {}
for side in ("main", "dev"):
    for path in sorted(glob.glob(f"{g}/recheck-{side}-*.log")):
        for test in re.findall(r"^\s*\d+ - (\S+) \(", read(path), re.M):
            recheck.setdefault(test, {"main": 0, "dev": 0})[side] += 1
runs = len(glob.glob(f"{g}/recheck-dev-*.log"))
devices = re.findall(r"deviceName\s*=\s*(.+)", info)
drivers = re.findall(r"driverInfo\s*=\s*(.+)", info)
pick = next((i for i, device in enumerate(devices) if name and name in device), 0)
missing = "was not found but was requested by env var VK_INSTANCE_LAYERS"
result = {
    "status": "done", "gpu": (devices[pick].strip() if devices else name) + (f", {drivers[pick].strip()}" if len(drivers) > pick else ""),
    "main": read(f"{out}/main.sha").strip(), "head": read(f"{out}/head.sha").strip(), "selected": len(lines(f"{out}/tests.txt")),
    "mainSummary": summary(main_log), "devSummary": summary(dev_log), "layerMissing": {"main": missing in main_log, "dev": missing in dev_log},
    "onlyDev": [{"test": t, "recheckFailures": recheck.get(t, {"main": 0, "dev": 0}), "recheckRuns": runs} for t in sorted(dev_failed - main_failed - new)],
    "onlyMain": sorted(main_failed - dev_failed),
    "newTests": [{"test": t, "passed": t not in dev_failed and t in dev_log} for t in sorted(new)],
    "newVuids": sorted(set(vuids(dev_log)) - set(vuids(main_log))),
}
real = [e for e in result["onlyDev"] if e["recheckFailures"]["dev"] > e["recheckFailures"]["main"]]
result["verdict"] = "regression" if real or result["newVuids"] or any(not t["passed"] for t in result["newTests"]) or result["layerMissing"]["dev"] else "clean"
json.dump(result, open(f"{g}/result.json", "w"), indent=1)
P
  step "[$GPU_ID] $(python3 -c "import json;print(json.load(open('$G/result.json'))['verdict'])")"
done < "$OUT/gpus.txt"
echo '{"status":"done"}' > "$OUT/result.json"
step "done"
