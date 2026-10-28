module.exports = {
  branches: ["main"],
  tagFormat: "${version}",
  plugins: [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    [
      "@semantic-release/changelog",
      {
        changelogFile: "CHANGELOG.md",
      },
    ],
    [
      "@semantic-release/exec",
      {
        prepareCmd: 'node -e "const p=require(\'./package.json\'); p.version=process.env.NPM_CONFIG__SEMANTIC_RELEASE_NEXT_VERSION || p.version; require(\'fs\').writeFileSync(\'package.json\', JSON.stringify(p, null, 2) + \'\\n\')"',
      },
    ],
    [
      "@semantic-release/git",
      {
        assets: ["CHANGELOG.md", "package.json"],
        message: "chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}",
      },
    ],
  ],
  repositoryUrl: process.env.GIT_URL || "https://github.com/npujol/german-language-coach",
};
