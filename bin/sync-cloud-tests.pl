#!/usr/bin/perl

# sync-cloud-tests.pl - Push the benchmark scripts up to Grafana Cloud as
# SCRIPT-EDITOR tests, so people can run them from the web UI against any
# server: they open a test, clone it ( Save as... ), edit the values marked
# "<<< SET" at the top of the script, and click Run.
#
# These are script-editor tests ( the script text lives in the test and is
# editable/clonable in the browser ), NOT CLI archive tests - so this uses the
# k6 Cloud REST API to create/update each test's script, keyed by
# ( project, name ). Re-running updates the script in place; it never touches a
# clone someone made.
#
# Usage:
#   ./bin/sync-cloud-tests.pl                 # create/update all templates
#   ./bin/sync-cloud-tests.pl --dry-run       # show what would change, do nothing
#   ./bin/sync-cloud-tests.pl opac daily      # only tests whose script/name matches
#   ./bin/sync-cloud-tests.pl --project 12345 # override CLOUD_PROJECT_ID
#   ./bin/sync-cloud-tests.pl --env prod.env  # read CLOUD_PROJECT_ID from another file
#
# Auth: reuses the token from 'k6 cloud login' ( ~/Library/Application Support/
# k6/config.json ). Run that once first.

use Modern::Perl;
use Getopt::Long;
use FindBin;
use HTTP::Tiny;
use JSON::PP;

my $API = "https://api.k6.io/loadtests/v2/tests";

# script file => cloud test name. These names are the templates people clone.
my @SYNC_TESTS = (
    [ "koha_opac_http.js",         "OPAC Stress Test - HTTP Only" ],
    [ "koha_steady_state.js",      "Daily Operations" ],
    [ "koha_training_protocol.js", "Training Simulation - HTTP Only" ],
    [ "koha_training_browser.js",  "Training Simulation - End to End" ],
);

my $bench_dir = "$FindBin::Bin/../benchmarks";
my $env_file  = "$FindBin::Bin/../.env";
my ( $project_override, $dry_run, $help );

GetOptions(
    'env=s'     => \$env_file,
    'project=s' => \$project_override,
    'dry-run'   => \$dry_run,
    'help'      => \$help,
) or die "Try --help\n";

_usage() if $help;

# Remaining args are name/script substring filters
my @filters = @ARGV;

# Project id: --project wins, else CLOUD_PROJECT_ID from the env file
my $project_id = $project_override // _env_value( $env_file, 'CLOUD_PROJECT_ID' );
die "Error: no project id. Set CLOUD_PROJECT_ID in $env_file or pass --project <id>.\n"
    unless defined $project_id && length $project_id;

my $token = _k6_token();
my $http  = HTTP::Tiny->new;

# Existing tests in the project, name => id
my %existing;
{
    my $res = _api( 'GET', "$API?project_id=$project_id&page_size=100" );
    die "Error listing tests: HTTP $res->{status}\n" unless $res->{success};
    my $data = decode_json( $res->{content} );
    for my $t ( @{ $data->{'k6-tests'} || [] } ) {
        my $tt = $t->{'k6-test'} // $t;
        $existing{ $tt->{name} } = $tt->{id};
    }
}

say "=" x 42;
say "Syncing script-editor templates  (project $project_id)";
say "  DRY RUN - nothing will be written" if $dry_run;
say "=" x 42;

my ( $done, $fails ) = ( 0, 0 );

for my $entry (@SYNC_TESTS) {
    my ( $file, $name ) = @$entry;
    next if @filters && !grep { index( "$file|$name", $_ ) >= 0 } @filters;

    my $path = "$bench_dir/$file";
    unless ( -f $path ) {
        say "\n>> SKIP  $name  (script not found: $file)";
        $fails++;
        next;
    }

    my $tid    = $existing{$name};
    my $action = $tid ? "update" : "create";
    say "\n>> $name";
    say "   $file  ->  $action" . ( $tid ? " (id $tid)" : "" );
    next if $dry_run;

    my $script = _slurp($path);
    my $res;
    if ($tid) {
        $res = _api( 'PATCH', "$API/$tid", { script => $script } );
    } else {
        $res = _api( 'POST', $API, { name => $name, project_id => int($project_id), script => $script } );
        if ( $res->{success} ) {
            my $obj = decode_json( $res->{content} );
            $tid = ( $obj->{'k6-test'} // $obj )->{id};
        }
    }

    if ( $res->{success} ) {
        say "   OK  https://bws.grafana.net/a/k6-app/tests/$tid";
        $done++;
    } else {
        say "   FAILED  HTTP $res->{status}: " . _short( $res->{content} );
        $fails++;
    }
}

say "\n" . "=" x 42;
say "Done: $done synced, $fails failed";
say "=" x 42;
exit( $fails ? 1 : 0 );

# ------------------------------------------------------------

sub _api {
    my ( $method, $url, $body ) = @_;
    my %opts = ( headers => { Authorization => "Bearer $token" } );
    if ( defined $body ) {
        $opts{headers}{'Content-Type'} = 'application/json';
        $opts{content} = encode_json($body);
    }
    return $http->request( $method, $url, \%opts );
}

# Read a single KEY's value from a simple KEY=value env file ( ignores comments,
# strips surrounding quotes ). Returns undef if not found or file absent.
sub _env_value {
    my ( $file, $key ) = @_;
    return undef unless -f $file;
    open my $fh, '<', $file or return undef;
    while ( my $line = <$fh> ) {
        next if $line =~ /^\s*#/;
        if ( $line =~ /^\s*\Q$key\E\s*=\s*(.*?)\s*$/ ) {
            my $v = $1;
            $v =~ s/^["']//; $v =~ s/["']$//;
            return $v;
        }
    }
    return undef;
}

sub _k6_token {
    my $cfg = "$ENV{HOME}/Library/Application Support/k6/config.json";
    die "Error: k6 config not found at $cfg - run 'k6 cloud login --token <token>' first.\n"
        unless -f $cfg;
    my $data = decode_json( _slurp($cfg) );
    my $tok = $data->{collectors}{cloud}{token}
        or die "Error: no cloud token in $cfg - run 'k6 cloud login' first.\n";
    return $tok;
}

sub _slurp {
    my ($path) = @_;
    open my $fh, '<', $path or die "Cannot read $path: $!\n";
    local $/;
    return <$fh>;
}

sub _short { my ($s) = @_; $s //= ''; $s =~ s/\s+/ /g; return substr( $s, 0, 200 ); }

# Print the leading comment block ( the usage header ) and exit.
sub _usage {
    open my $fh, '<', $0 or exit 1;
    my $seen;
    while ( my $l = <$fh> ) {
        next if $l =~ /^#!/;                 # skip shebang
        next if !$seen && $l =~ /^\s*$/;     # skip blank lines before the header
        last unless $l =~ /^#/;              # stop at the first non-comment line
        $seen = 1;
        $l =~ s/^# ?//;
        print $l;
    }
    exit 0;
}
