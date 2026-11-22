use std::path::{Path, PathBuf};

const BUNDLED_SCRCPY_VERSION: &str = "5.0.1";

#[derive(Clone, Debug)]
pub struct AndroidTools {
    adb: PathBuf,
    scrcpy_server: Option<PathBuf>,
}

impl AndroidTools {
    pub fn from_resource_dir(resource_dir: &Path) -> Self {
        let bundled_roots = [
            resource_dir.join("tools"),
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/tools"),
        ];

        for root in bundled_roots {
            let adb = root.join("adb/adb.exe");
            let scrcpy_server = root.join("scrcpy/scrcpy-server");

            if adb.is_file() && scrcpy_server.is_file() {
                return Self {
                    adb,
                    scrcpy_server: Some(scrcpy_server),
                };
            }
        }

        Self::system()
    }

    pub fn system() -> Self {
        Self {
            adb: PathBuf::from("adb"),
            scrcpy_server: None,
        }
    }

    pub fn adb(&self) -> &Path {
        &self.adb
    }

    pub fn bundled_scrcpy(&self) -> Option<(&Path, &str)> {
        self.scrcpy_server
            .as_deref()
            .map(|server| (server, BUNDLED_SCRCPY_VERSION))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn prefers_bundled_tools_from_resource_directory() {
        let resource_dir =
            std::env::temp_dir().join(format!("mirrune-tools-test-{}", uuid::Uuid::new_v4()));
        let tools_dir = resource_dir.join("tools");
        let adb_path = tools_dir.join("adb/adb.exe");
        let server_path = tools_dir.join("scrcpy/scrcpy-server");

        fs::create_dir_all(adb_path.parent().unwrap()).unwrap();
        fs::create_dir_all(server_path.parent().unwrap()).unwrap();
        fs::write(&adb_path, b"").unwrap();
        fs::write(&server_path, b"").unwrap();

        let tools = AndroidTools::from_resource_dir(&resource_dir);

        assert_eq!(tools.adb(), adb_path.as_path());
        assert_eq!(
            tools.bundled_scrcpy(),
            Some((server_path.as_path(), BUNDLED_SCRCPY_VERSION))
        );

        fs::remove_dir_all(resource_dir).unwrap();
    }
}
