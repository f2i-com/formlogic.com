#!/usr/bin/env python3
"""patch_lance_sharding.py <path-to-lance_gradio.py>

Applied by install-lance.bat after the repo is fetched. Injects an OPTIONAL
multi-GPU sharding / CPU-offload path into Lance's gradio server so a single
large clip can span both GPUs (the stock server puts one full model copy per
GPU — concurrency, not sharding).

The patch is INERT by default: it only changes behaviour when, at runtime:
  FORMLOGIC_LANCE_SHARD=1   -> accelerate device_map across all visible GPUs
  FORMLOGIC_LANCE_OFFLOAD=1 -> accelerate sequential CPU offload (slow, fits anything)
  FORMLOGIC_LANCE_SHARD_MEM -> optional per-GPU cap for the shard (e.g. "30GiB")
Otherwise the model loads exactly as before (`model.to(device)`).

Idempotent (skips if already patched) and graceful (if an anchor isn't found
it writes nothing and explains, so a future Lance layout change can't corrupt
the file). Safe to run on every install.

EXPERIMENTAL: device_map sharding of Lance's custom Lance(Qwen2 + ViT +
WanVideoVAE) composite can only be validated on a real 2-GPU run — if its
forward hardcodes a device, dispatch may need a tweak. The CPU-offload mode is
the reliable fits-anything fallback.
"""
import sys

MARKER = "# FORMLOGIC_SHARD_PATCH"

HELPERS = '''\
# FORMLOGIC_SHARD_PATCH: optional multi-GPU sharding / CPU offload (companion-injected).
# Inert unless FORMLOGIC_LANCE_SHARD=1 or FORMLOGIC_LANCE_OFFLOAD=1 at runtime.
def _formlogic_shard_enabled():
    import os, torch
    return (
        os.getenv("FORMLOGIC_LANCE_SHARD") == "1"
        and torch.cuda.is_available()
        and torch.cuda.device_count() > 1
    )

def _formlogic_offload_enabled():
    import os, torch
    return os.getenv("FORMLOGIC_LANCE_OFFLOAD") == "1" and torch.cuda.is_available()

def _formlogic_maybe_collapse(gpu_ids):
    # Shard / offload run a SINGLE pipeline (one model spanning the GPUs),
    # so collapse the per-GPU pool to one entry.
    try:
        if (_formlogic_shard_enabled() or _formlogic_offload_enabled()) and len(gpu_ids) > 1:
            print(f"[FormLogic] shard/offload: collapsing GPU pool {gpu_ids} -> [{gpu_ids[0]}]", flush=True)
            return gpu_ids[:1]
    except Exception as _e:
        print(f"[FormLogic] maybe_collapse error: {_e}", flush=True)
    return gpu_ids

def _formlogic_no_split(model):
    names = set()
    try:
        for _n, m in model.named_modules():
            for cn in (getattr(m, "_no_split_modules", None) or []):
                names.add(cn)
    except Exception:
        pass
    # Sensible fallback so decoder layers are never split mid-block.
    names.update({"Qwen2DecoderLayer", "Qwen2_5_VLDecoderLayer", "Qwen2MoeDecoderLayer"})
    return list(names)

def _formlogic_place_model(model, device):
    import os, torch
    if _formlogic_offload_enabled():
        try:
            from accelerate import cpu_offload
            print("[FormLogic] sequential CPU offload (slow, fits any size)", flush=True)
            return cpu_offload(model, execution_device=torch.device(f"cuda:{device}"))
        except Exception as e:
            print(f"[FormLogic] cpu_offload failed ({e}); single GPU {device}", flush=True)
            return model.to(device=device)
    if _formlogic_shard_enabled():
        try:
            from accelerate import dispatch_model, infer_auto_device_map
            from accelerate.utils import get_balanced_memory
            n = torch.cuda.device_count()
            per = os.getenv("FORMLOGIC_LANCE_SHARD_MEM", "").strip()
            no_split = _formlogic_no_split(model)
            if per:
                max_memory = {i: per for i in range(n)}
            else:
                max_memory = get_balanced_memory(
                    model, dtype=torch.bfloat16, no_split_module_classes=no_split
                )
            dmap = infer_auto_device_map(
                model, max_memory=max_memory, dtype=torch.bfloat16,
                no_split_module_classes=no_split,
            )
            devs = sorted({str(v) for v in dmap.values()})
            print(f"[FormLogic] sharding Lance across {n} GPUs; devices: {devs}", flush=True)
            return dispatch_model(model, device_map=dmap)
        except Exception as e:
            print(f"[FormLogic] device_map shard failed ({e}); single GPU {device}", flush=True)
            return model.to(device=device)
    return model.to(device=device)

'''

# (anchor, replacement) — every anchor MUST be found or we abort untouched.
REPLACEMENTS = [
    (
        "class LanceT2VV2TPipeline:",
        HELPERS + "\nclass LanceT2VV2TPipeline:",
    ),
    (
        "model = model.to(device=self.device)",
        "model = _formlogic_place_model(model, self.device)",
    ),
    (
        "        self.gpu_ids = gpu_ids\n",
        "        gpu_ids = _formlogic_maybe_collapse(gpu_ids)\n        self.gpu_ids = gpu_ids\n",
    ),
]


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: patch_lance_sharding.py <path-to-lance_gradio.py>")
        return 2
    path = sys.argv[1]
    try:
        with open(path, "r", encoding="utf-8") as f:
            src = f.read()
    except OSError as e:
        print(f"[patch_lance] cannot read {path}: {e}")
        return 1

    if MARKER in src:
        print("[patch_lance] already patched; nothing to do.")
        return 0

    # Verify every anchor is present BEFORE touching anything.
    missing = [a for a, _ in REPLACEMENTS if a not in src]
    if missing:
        print("[patch_lance] anchors not found (Lance layout changed?); leaving file unchanged:")
        for a in missing:
            print(f"   - {a!r}")
        print("[patch_lance] sharding stays unavailable; concurrency mode still works.")
        return 0  # non-fatal — don't break the install

    out = src
    for anchor, repl in REPLACEMENTS:
        out = out.replace(anchor, repl, 1)

    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write(out)
    except OSError as e:
        print(f"[patch_lance] cannot write {path}: {e}")
        return 1

    print("[patch_lance] applied. Set FORMLOGIC_LANCE_SHARD=1 (device_map across GPUs)")
    print("[patch_lance] or FORMLOGIC_LANCE_OFFLOAD=1 (CPU offload) to activate it.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
