// Because parcel.js is broken and I need to get rid of it.
const fs = require('fs/promises');

const manifestPath = './dist/manifest.json';

/**
 * Add jscl.js without running it through parcel to the final addon. When run
 * through parcel, jscl seem to start throwing some errors.
 */
const addJscl = async () => {
  const jsclSrcPath = './src/apps/Jscl/jscl.js';
  const jsclDestPath = './dist/apps/Jscl/jscl.js';

  await fs.copyFile(jsclSrcPath, jsclDestPath);
  let manifest = await fs.readFile(manifestPath);
  manifest = JSON.parse(manifest);

  if (manifest.background.scripts.indexOf('apps/Jscl/jscs.js') < 0)
    manifest.background.scripts.push('apps/Jscl/jscl.js');

  await fs.writeFile(manifestPath, JSON.stringify(manifest));
};

const fixBuild = async () => {
  console.log('Adding jscl.js');
  await addJscl();
};

fixBuild()
  .catch((err) => {
    console.error(err);
  })
  .finally(() => process.exit());
