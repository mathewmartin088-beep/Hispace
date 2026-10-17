// Stamps the Hispace icon and product info into the Windows exe.
// electron-builder normally does this with rcedit, which needs Wine when building on Linux.
const fs = require('fs');
const path = require('path');
const ResEdit = require('resedit');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const exePath = path.join(context.appOutDir, context.packager.appInfo.productFilename + '.exe');
  const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath));
  const res = ResEdit.NtExecutableResource.from(exe);

  const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(__dirname, 'icon.ico')));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const target = groups[0] || { id: 1, lang: 1033 };
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, target.id, target.lang, iconFile.icons.map((i) => i.data));

  const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0];
  if (vi) {
    const strings = { FileDescription: 'Hispace', ProductName: 'Hispace', InternalName: 'Hispace', OriginalFilename: 'Hispace.exe', CompanyName: 'Mathew', LegalCopyright: 'Mathew' };
    vi.setStringValues({ lang: vi.lang[0] ? vi.lang[0].lang : 1033, codepage: 1200 }, strings);
    vi.outputToResourceEntries(res.entries);
  }
  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
  console.log('  • stamped icon and version info into', path.basename(exePath));
};
