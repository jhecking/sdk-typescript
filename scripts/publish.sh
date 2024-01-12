#!/bin/zsh
set -euo pipefail

local workdir=$( mktemp -d -t sdk-typescript-release )
trap 'cd / && rm -rf "$workdir"' EXIT
cd "$workdir"

# Manually download all native artifacts from the latest main build

mkdir -p artifacts package/releases
open artifacts

echo -e 'Please do the following:'
echo -e ' 1. Open the \e]8;;https://github.com/temporalio/sdk-typescript/actions/workflows/ci.yml?query=branch%3Amain\e\\GHA status page\e]8;;\e\\ for the "Continuous Integration" workflow, on branch main.'
echo -e ' 2. From there, select the latest execution'
echo -e ' 3. Download all packages-* artifacts to the "artifacts" directory that just opened'

echo
echo -e 'Press ENTER once this is completed.'
read enterKey

local count=$( find artifacts -type f -name "packages-*.zip" | wc -l )
if [ $count -ne 5 ]; then
    echo "The 'artifacts' directory does not contain exactly 5 files named 'packages-*.zip'"
    echo "Aborting"
    exit 1
fi

# Extract native libs and organize them correctly
for name in artifacts/*.zip ; do
    unzip -cq ${name} '@temporalio/core-bridge/core-bridge-*.tgz' |
        tar -xvz package/releases/
done

git clone --depth 1 --shallow-submodules --recurse-submodules https://github.com/temporalio/sdk-typescript.git
cd sdk-typescript

npm ci  --ignore-scripts
npm run build -- --ignore @temporalio/core-bridge

cp -r ../package/releases packages/core-bridge/releases

echo
echo 'Does this look correct?'
echo
ls -l packages/core-bridge/releases/*/*

echo
echo 'Press ENTER to go on with publishing, or Ctrl+C to abort'

read enterKey

echo 'Publishing...'

# User will be asked to indicate which type of release and to confirm,
# then the Publish commit will be created and pushed to the main branch.
npx lerna version patch --force-publish='*'

local version=$( jq -r '.version' < lerna.json )

git checkout -B fix-deps
node scripts/prepublish.mjs
git commit -am 'Fix dependencies'

# Check if the version matches the pattern
if [[ $version =~ '^[0-9]+\.[0-9]+\.[0-9]+$' ]]; then
    npx lerna publish from-package
else
    npx lerna publish from-package --dist-tag next
fi

npm deprecate "temporalio@^${version}" "Instead of installing temporalio, we recommend directly installing our packages: npm remove temporalio; npm install @temporalio/client @temporalio/worker @temporalio/workflow @temporalio/activity"

echo -e 'Please do the following:'
echo -e ' 1. Open the \e]8;https://github.com/temporalio/sdk-typescript/releases/new?tag=v'"$version"'\e\\GitHub New Release page\e]8;;\e\\ and select the '"$version"' tag.'
echo -e ' 2. In the Release Title field, enter '"$version"''
echo -e ' 3. Paste the release notes inkto the description field'
if [[ $version =~ '^[0-9]+\.[0-9]+\.[0-9]+$' ]]; then
    echo -e ' 4. Make sure that the "Set as a pre-release" checkbox is unchecked'
    echo -e '    and that the "Set as the latest release" checkbox is checked'
else
    echo -e ' 4. Make sure that the "Set as a pre-release" checkbox is checked'
    echo -e '    and that the "Set as the latest release" checkbox is unchecked'
fi
echo -e ' 5. Press the "Save draft" button, then ask someone else to review'
echo -e ' 6. Press the "Publish Release" buton to complete the release process'

echo
echo -e 'Press ENTER once this is completed.'
read enterKey

cd "$workdir"

if [[ $version =~ '^[0-9]+\.[0-9]+\.[0-9]+$' ]]; then
  git clone --depth 1 --shallow-submodules --recurse-submodules https://github.com/temporalio/features.git
  cd features

  # Update typescript_latest in ci.yaml
  sed -i '' 's%^\([ ]*typescript_latest: \).*$%\1\''"$version"'\'%' .github/workflows/ci.yaml

  # Update @temporalio/* dependencies in package.json
  sed -i '' 's#\("@temporalio/.*": "^\)[^"]*\(",\)#\1'"$version"'\2#' package.json

  # Update package-lock.json
  npm i
fi