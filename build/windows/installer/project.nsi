Unicode true

####
## Please note: Template replacements don't work in this file. They are provided with default defines like
## mentioned underneath.
## If the keyword is not defined, "wails_tools.nsh" will populate them with the values from ProjectInfo.
## If they are defined here, "wails_tools.nsh" will not touch them. This allows to use this project.nsi manually
## from outside of Wails for debugging and development of the installer.
##
## For development first make a wails nsis build to populate the "wails_tools.nsh":
## > wails build --target windows/amd64 --nsis
## Then you can call makensis on this file with specifying the path to your binary:
## For a AMD64 only installer:
## > makensis -DARG_WAILS_AMD64_BINARY=..\..\bin\app.exe
## For a ARM64 only installer:
## > makensis -DARG_WAILS_ARM64_BINARY=..\..\bin\app.exe
## For a installer with both architectures:
## > makensis -DARG_WAILS_AMD64_BINARY=..\..\bin\app-amd64.exe -DARG_WAILS_ARM64_BINARY=..\..\bin\app-arm64.exe
####
## The following information is taken from the ProjectInfo file, but they can be overwritten here.
####
## !define INFO_PROJECTNAME    "MyProject" # Default "{{.Name}}"
## !define INFO_COMPANYNAME    "MyCompany" # Default "{{.Info.CompanyName}}"
## !define INFO_PRODUCTNAME    "MyProduct" # Default "{{.Info.ProductName}}"
## !define INFO_PRODUCTVERSION "1.0.0"     # Default "{{.Info.ProductVersion}}"
## !define INFO_COPYRIGHT      "Copyright" # Default "{{.Info.Copyright}}"
###
## !define PRODUCT_EXECUTABLE  "Application.exe"      # Default "${INFO_PROJECTNAME}.exe"
## !define UNINST_KEY_NAME     "UninstKeyInRegistry"  # Default "${INFO_COMPANYNAME}${INFO_PRODUCTNAME}"
####
## !define REQUEST_EXECUTION_LEVEL "admin"            # Default "admin"  see also https://nsis.sourceforge.io/Docs/Chapter4.html
####
## Include the wails tools
####
!include "wails_tools.nsh"

# The version information for this two must consist of 4 parts
VIProductVersion "${INFO_PRODUCTVERSION}.0"
VIFileVersion    "${INFO_PRODUCTVERSION}.0"

VIAddVersionKey "CompanyName"     "${INFO_COMPANYNAME}"
VIAddVersionKey "FileDescription" "${INFO_PRODUCTNAME} Installer"
VIAddVersionKey "ProductVersion"  "${INFO_PRODUCTVERSION}"
VIAddVersionKey "FileVersion"     "${INFO_PRODUCTVERSION}"
VIAddVersionKey "LegalCopyright"  "${INFO_COPYRIGHT}"
VIAddVersionKey "ProductName"     "${INFO_PRODUCTNAME}"

# Enable HiDPI support. https://nsis.sourceforge.io/Reference/ManifestDPIAware
ManifestDPIAware true

!include "MUI.nsh"

!define MUI_ICON "..\icon.ico"
!define MUI_UNICON "..\icon.ico"
# !define MUI_WELCOMEFINISHPAGE_BITMAP "resources\leftimage.bmp" #Include this to add a bitmap on the left side of the Welcome Page. Must be a size of 164x314
!define MUI_FINISHPAGE_NOAUTOCLOSE # Wait on the INSTFILES page so the user can take a look into the details of the installation steps
!define MUI_ABORTWARNING # This will warn the user if they exit from the installer.

!insertmacro MUI_PAGE_WELCOME # Welcome to the installer page.
# !insertmacro MUI_PAGE_LICENSE "resources\eula.txt" # Adds a EULA page to the installer
!insertmacro MUI_PAGE_DIRECTORY # In which folder install page.
!insertmacro MUI_PAGE_INSTFILES # Installing page.

# Add a "Run Blueprint" checkbox to the install-complete page. Checked
# by default so the user doesn't have to hunt for the start-menu
# shortcut after installation. MUI_FINISHPAGE_RUN_NOTCHECKED would
# leave it unchecked; we want the friction-free "next step is launch
# the app" flow.
!define MUI_FINISHPAGE_RUN "$INSTDIR\${PRODUCT_EXECUTABLE}"
!define MUI_FINISHPAGE_RUN_TEXT "Run Blueprint now"
!insertmacro MUI_PAGE_FINISH # Finished installation page.

!insertmacro MUI_UNPAGE_INSTFILES # Uinstalling page

!insertmacro MUI_LANGUAGE "English" # Set the Language of the installer

## The following two statements can be used to sign the installer and the uninstaller. The path to the binaries are provided in %1
#!uninstfinalize 'signtool --file "%1"'
#!finalize 'signtool --file "%1"'

Name "${INFO_PRODUCTNAME}"
OutFile "..\..\bin\${INFO_PROJECTNAME}-${ARCH}-installer.exe" # Name of the installer's file.
InstallDir "$PROGRAMFILES64\${INFO_COMPANYNAME}\${INFO_PRODUCTNAME}" # Default installing folder ($PROGRAMFILES is Program Files folder).
ShowInstDetails show # This will always show the installation details.

Function .onInit
   !insertmacro wails.checkArchitecture
FunctionEnd

Section
    !insertmacro wails.setShellContext

    !insertmacro wails.webview2runtime

    SetOutPath $INSTDIR

    !insertmacro wails.files

    # Ship the Windows Service binary alongside blueprint.exe. The
    # release pipeline writes blueprint-svc.exe into the same build/bin/
    # directory the wails NSIS template pulls .exe files from, so this
    # is a sibling File include.
    File "..\..\bin\blueprint-svc.exe"

    CreateShortcut "$SMPROGRAMS\${INFO_PRODUCTNAME}.lnk" "$INSTDIR\${PRODUCT_EXECUTABLE}"
    CreateShortCut "$DESKTOP\${INFO_PRODUCTNAME}.lnk" "$INSTDIR\${PRODUCT_EXECUTABLE}"

    !insertmacro wails.associateFiles
    !insertmacro wails.associateCustomProtocols

    # Register the Blueprint LLM Service with the Windows Service
    # Control Manager. Idempotent — if the service exists (e.g. user
    # is upgrading), we uninstall it first.
    DetailPrint "Installing Blueprint LLM Service…"
    nsExec::ExecToLog '"$INSTDIR\blueprint-svc.exe" uninstall'
    nsExec::ExecToLog '"$INSTDIR\blueprint-svc.exe" install'
    Pop $0
    ${If} $0 != 0
        DetailPrint "Service install returned $0 — you can install it manually later with: $INSTDIR\blueprint-svc.exe install"
    ${EndIf}

    !insertmacro wails.writeUninstaller
SectionEnd

Section "uninstall"
    !insertmacro wails.setShellContext

    # Stop the Windows Service FIRST. The supervisor holds file handles
    # in $PROFILE\.blueprint (svc-token, logs) and on the model GGUFs
    # it's actively serving — if we try to wipe the user data dir
    # before stopping the service, RMDir leaves files behind silently
    # and the "delete data" flow appears not to work. Stop-then-wipe
    # avoids the file-locked-by-service partial-delete bug.
    DetailPrint "Stopping + removing Blueprint LLM Service…"
    nsExec::ExecToLog '"$INSTDIR\blueprint-svc.exe" uninstall'
    # Give the SCM a moment to release handles. ~1s is enough in
    # practice for SCM_STOP to propagate through the supervisor's
    # shutdown path.
    Sleep 1500

    # Now ask whether the user also wants to wipe their personal
    # Blueprint data. Default is No (safe for upgrades/reinstalls;
    # the data dir can hold tens of GB of model weights). /SD IDNO
    # also defaults silent uninstalls to No so unattended runs never
    # accidentally delete a fleet's worth of GGUFs.
    MessageBox MB_YESNO|MB_ICONQUESTION \
        "Also delete your Blueprint user data?$\n$\nThis removes models, calibration runs, configurations, LoRA adapters, logs, and the Windows Service supervisor state from:$\n   $PROFILE\.blueprint$\n   $PROGRAMDATA\Blueprint$\n$\nThis directory can contain many GB of downloaded model weights. Choose No if you plan to reinstall and want to keep them; choose Yes for a true clean removal." \
        /SD IDNO IDNO skip_userdata
        DetailPrint "Removing user data at $PROFILE\.blueprint…"
        RMDir /r "$PROFILE\.blueprint"
        # ALSO wipe %ProgramData%\Blueprint — the service writes its
        # config (service-config.json) and status (service-status.json)
        # plus its logs here. If we leave this around, a fresh
        # reinstall + service-install picks up the previous serve
        # config and immediately tries to spawn llama-server with a
        # model path that may not exist post-wipe. Clean both halves
        # together.
        DetailPrint "Removing supervisor state at $PROGRAMDATA\Blueprint…"
        RMDir /r "$PROGRAMDATA\Blueprint"
    skip_userdata:

    RMDir /r "$AppData\${PRODUCT_EXECUTABLE}" # Remove the WebView2 DataPath

    RMDir /r $INSTDIR

    Delete "$SMPROGRAMS\${INFO_PRODUCTNAME}.lnk"
    Delete "$DESKTOP\${INFO_PRODUCTNAME}.lnk"

    !insertmacro wails.unassociateFiles
    !insertmacro wails.unassociateCustomProtocols

    !insertmacro wails.deleteUninstaller
SectionEnd

# Needed for the ${If} macro above.
!include "LogicLib.nsh"
