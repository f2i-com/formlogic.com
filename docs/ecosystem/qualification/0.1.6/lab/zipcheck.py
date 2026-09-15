import sys, zipfile
z = zipfile.ZipFile(sys.argv[1]); names = z.namelist()
back = [n for n in names if "\\" in n]; fwd = [n for n in names if "/" in n]
print("entries", len(names), "with backslash separators", len(back), "with forward slashes", len(fwd))
print("sample backslash entries:", back[:3])
runtime = [i for i in z.infolist() if i.filename.replace("\\", "/").endswith("formlogic-runtime-linux-x86_64")]
print("runtime binary external attrs:", [oct(i.external_attr >> 16) for i in runtime], "create_system:", [i.create_system for i in runtime])
