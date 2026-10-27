{pkgs, ...}:
pkgs.buildNpmPackage {
  dontNpmBuild = true;
  doCheck = true;
  npmCheckScript = "test";
  pname = "pi-german-coach";
  version = "1.0.0";

  src = ./.;
  npmDeps = pkgs.importNpmLock {npmRoot = ./.;};
  npmConfigHook = pkgs.importNpmLock.npmConfigHook;
  nativeBuildInputs = [pkgs.makeWrapper];
  postInstall = ''
    wrapProgram $out/bin/german-coach --prefix PATH : ${pkgs.nodejs}/bin
  '';

  meta = with pkgs.lib; {
    description = "Durable local German writing coach for Pi sessions";
    license = licenses.mit;
    mainProgram = "german-coach";
  };
}
