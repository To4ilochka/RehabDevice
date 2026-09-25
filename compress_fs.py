Import("env")
import os
import shutil
import gzip
from SCons.Script import COMMAND_LINE_TARGETS

project_dir = env.subst("$PROJECT_DIR")
data_dir = os.path.join(project_dir, "data")
build_dir = env.subst("$BUILD_DIR")
compressed_data_dir = os.path.join(build_dir, "data_compressed")

# Tell PlatformIO to use the compressed directory for LittleFS
env.Replace(PROJECT_DATA_DIR=compressed_data_dir)

def prepare_filesystem():
    print("\n[Auto-GZIP] Preparing compressed data directory...")
    
    if os.path.exists(compressed_data_dir):
        shutil.rmtree(compressed_data_dir)
    os.makedirs(compressed_data_dir)
    
    for root, dirs, files in os.walk(data_dir):
        for file in files:
            orig_path = os.path.join(root, file)
            rel_path = os.path.relpath(orig_path, data_dir)
            
            is_compressible = file.endswith((".html", ".css", ".js", ".json", ".svg", ".txt"))
            dest_rel = rel_path + ".gz" if is_compressible else rel_path
            dest_path = os.path.join(compressed_data_dir, dest_rel)
            
            os.makedirs(os.path.dirname(dest_path), exist_ok=True)
            
            if is_compressible:
                with open(orig_path, "rb") as f_in, open(dest_path, "wb") as compressed_file, gzip.GzipFile(filename="", mode="wb", fileobj=compressed_file, mtime=0) as f_out:
                    shutil.copyfileobj(f_in, f_out)
            else:
                shutil.copy2(orig_path, dest_path)
                
    print("[Auto-GZIP] Compression complete.\n")

if set(COMMAND_LINE_TARGETS) & {"buildfs", "uploadfs", "uploadfsota"}:
    prepare_filesystem()
