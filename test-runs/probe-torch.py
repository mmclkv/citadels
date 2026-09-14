import torch, sys
print("torch:", torch.__version__, "cuda_available:", torch.cuda.is_available())
if torch.cuda.is_available():
    print("GPU:", torch.cuda.get_device_name(0), "| VRAM_MB:", round(torch.cuda.get_device_properties(0).total_memory / 1048576))
print("python:", sys.version.split()[0])
